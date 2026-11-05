import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    voxelAt,
    validateVoxelReference,
    readVoxelOccupancy,
    voxelSolidVolume,
    VoxelReferenceReader,
} from '../src/voxel-inspection.js';

const world = { minX: 0, minY: 0, minZ: 0, maxX: 200, maxY: 200, maxZ: 200 };
function binary(columns: number[][][]): ArrayBuffer {
    const bytes = 8 + columns.reduce((n, c) => n + 4 + c.length * 12, 0);
    const buffer = new ArrayBuffer(bytes),
        view = new DataView(buffer);
    view.setInt32(0, 2, true);
    view.setInt32(4, 2, true);
    let offset = 8;
    for (const column of columns) {
        view.setInt32(offset, column.length, true);
        offset += 4;
        for (const interval of column)
            for (const v of interval) {
                view.setInt32(offset, v, true);
                offset += 4;
            }
    }
    return buffer;
}
function fixture(columns: number[][][], bounds = world) {
    const buffer = binary(columns);
    const tile = { bounds, url: 'cubes/test.air.gz', decodedBytes: buffer.byteLength };
    return { buffer, tile, data: readVoxelOccupancy(buffer, tile, 100) };
}
test('voxel identifiers use minimum-corner metres rather than scale-dependent indices', () => {
    const grid = {
        minX: -64000,
        minY: -64000,
        minZ: -64000,
        maxX: 64000,
        maxY: 64000,
        maxZ: 64000,
    };
    const positive = voxelAt({ x: 13500, y: 13500, z: 13500 }, { x: 0, y: 0, z: 1 }, grid, 6400);
    assert.equal(positive.tuple, '(128,128,128,64)');
    assert.equal(positive.bounds.maxX, 19200);
    const negative = voxelAt({ x: -13500, y: -13500, z: -13500 }, { x: 0, y: 0, z: 1 }, grid, 6400);
    assert.equal(negative.tuple, '(-192,-192,-192,64)');
    for (const size of [100, 200, 400, 800, 1600, 3200, 6400])
        assert.equal(
            voxelAt({ x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 1 }, grid, size).bounds.minZ,
            0,
        );
});
test('surface faces select solid inward cells, including negative faces and legacy fractional grids', () => {
    assert.equal(
        voxelAt({ x: 50, y: 50, z: 100 }, { x: 0, y: 0, z: 1 }, world, 100).bounds.minZ,
        0,
    );
    assert.equal(
        voxelAt({ x: 100, y: 50, z: 50 }, { x: -1, y: 0, z: 0 }, world, 100).bounds.minX,
        100,
    );
    const legacy = { ...world, minZ: -14, maxZ: 186 };
    assert.equal(
        voxelAt({ x: 50, y: 50, z: 86 }, { x: 0, y: 0, z: 1 }, legacy, 100).tuple,
        '(0,0,-0.14,1)',
    );
});
test('pinned voxel identity follows its original bounds across finer resident LODs and face boundaries', () => {
    const grid = { minX: -6400, minY: -6400, minZ: -6400, maxX: 6400, maxY: 6400, maxZ: 6400 };
    const normal = { x: 0, y: 0, z: 1 };
    const pinned = voxelAt({ x: 50, y: 50, z: 1600 }, normal, grid, 1600);
    const same = { x: 1500, y: 1500, z: 1600 };
    assert.notEqual(voxelAt(same, normal, grid, 100).tuple, pinned.tuple);
    assert.equal(voxelAt(same, normal, grid, pinned.sizeCm).tuple, pinned.tuple);
    assert.notEqual(voxelAt({ ...same, x: 1600 }, normal, grid, pinned.sizeCm).tuple, pinned.tuple);
    assert.notEqual(voxelAt({ ...same, z: 1601 }, normal, grid, pinned.sizeCm).tuple, pinned.tuple);
});
test('reference occupancy measures 0%, partial and 100% without counting excluded cells as solid', () => {
    for (const [columns, percent] of [
        [[[[0, 2, 0]], [[0, 2, 0]], [[0, 2, 0]], [[0, 2, -1]]], 0],
        [[[[0, 1, 0]], [[0, 2, 0]], [[0, 2, 0]], [[0, 2, -1]]], 12.5],
        [[[], [], [], []], 100],
    ] as const) {
        const { data, tile } = fixture(columns.map((c) => c.map((i) => [...i])));
        assert.equal((voxelSolidVolume(data, tile, 100, world) / 8_000_000) * 100, percent);
    }
});
test('edge-clipped reference cells use clipped volume, not nominal scale cubed', async () => {
    const bounds = { ...world, maxX: 150, maxY: 150, maxZ: 250 };
    const { buffer, tile } = fixture([[], [], [], []], bounds);
    const reference = validateVoxelReference(
        { version: 1, cellSizeCm: 100, tiles: [tile] },
        bounds,
        12800,
    );
    const reader = new VoxelReferenceReader(
        reference,
        'https://test.invalid/world.json',
        async () => new Response(buffer),
    );
    const selected = voxelAt({ x: 149, y: 149, z: 249 }, { x: 0, y: 0, z: 1 }, bounds, 100);
    assert.deepEqual(selected.bounds, {
        minX: 100,
        minY: 100,
        minZ: 200,
        maxX: 150,
        maxY: 150,
        maxZ: 250,
    });
    assert.equal(await reader.fill(selected.bounds, new AbortController().signal), 100);
});
test('inspection validation rejects missing partitions, unsafe URLs and malformed interval payloads', () => {
    const { tile, buffer } = fixture([[], [], [], []]);
    for (const url of [
        '../test.air.gz',
        '/test.air.gz',
        'https://untrusted.invalid/test.air.gz',
        'cubes/%2e%2e/test.air.gz',
    ])
        assert.throws(() =>
            validateVoxelReference(
                { version: 1, cellSizeCm: 100, tiles: [{ ...tile, url }] },
                world,
                12800,
            ),
        );
    assert.throws(() =>
        validateVoxelReference({ version: 1, cellSizeCm: 100, tiles: [] }, world, 12800),
    );
    assert.throws(() => readVoxelOccupancy(buffer.slice(0, -1), tile, 100));
    for (const interval of [
        [1, 1, 0],
        [0, 3, 0],
        [-1, 1, 0],
        [0, 1, 7],
    ]) {
        const invalid = binary([[interval], [], [], []]);
        assert.throws(() =>
            readVoxelOccupancy(invalid, { ...tile, decodedBytes: invalid.byteLength }, 100),
        );
    }
});
test('shared binary URLs cannot bypass validation on differently sized edge partitions', async () => {
    const { tile, buffer } = fixture([[], [], [], []]);
    const edge = { ...tile, bounds: { ...world, minX: 200, maxX: 300 } };
    const reference = validateVoxelReference(
        { version: 1, cellSizeCm: 100, tiles: [tile, edge] },
        { ...world, maxX: 300 },
        200,
    );
    const reader = new VoxelReferenceReader(
        reference,
        'https://test.invalid/world.json',
        async () => new Response(buffer),
    );
    assert.equal(await reader.fill(world, new AbortController().signal), 100);
    await assert.rejects(reader.fill(edge.bounds, new AbortController().signal), /does not match/);
});

test('reference reads are cached and aborted selections do not resolve successfully', async () => {
    const { tile, buffer } = fixture([[], [], [], []]);
    const reference = validateVoxelReference(
        { version: 1, cellSizeCm: 100, tiles: [tile] },
        world,
        12800,
    );
    let requests = 0;
    const reader = new VoxelReferenceReader(
        reference,
        'https://test.invalid/world.json',
        async () => {
            requests++;
            return new Response(buffer);
        },
    );
    for (let i = 0; i < 2; i++)
        assert.equal(await reader.fill(world, new AbortController().signal), 100);
    assert.equal(requests, 1);
    await assert.rejects(
        reader.fill({ ...world, maxX: Infinity }, new AbortController().signal),
        /not fully covered/,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(reader.fill(world, controller.signal), { name: 'AbortError' });
});
