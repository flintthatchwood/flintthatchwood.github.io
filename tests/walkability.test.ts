import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import {
    MAX_PATCHES,
    formatWalkabilitySlope,
    MAX_TILE_BYTES,
    PatchSampler,
    WalkabilityLayer,
    loadWalkability,
    patchGeometry,
    patchMaterial,
    validateWalkability,
    visitWalkability,
    type WalkabilityData,
    type WalkabilityManifest,
    type WalkabilityStatus,
    type WalkabilityTile,
} from '../src/walkability.js';

test('slope display rounds normal and degrees without changing raw classification metadata', () => {
    const metadata = Object.freeze({
        walkableFloorZ: 0.6427876353263855,
        walkableFloorAngle: 49.999998082284904,
    });
    assert.equal(
        formatWalkabilitySlope(metadata),
        'Export slope: floor normal Z ≥ 0.6428, angle 50.0°.',
    );
    assert.equal(metadata.walkableFloorZ, 0.6427876353263855);
    assert.equal(metadata.walkableFloorAngle, 49.999998082284904);
});

const tile: WalkabilityTile = {
    url: 'floors.bin',
    records: 2,
    bounds: { minX: -10000, minY: -10000, minZ: -10000, maxX: 10000, maxY: 10000, maxZ: 10000 },
};
function manifest(): WalkabilityManifest {
    return {
        version: 1,
        mapKey: 'test',
        recordFormat: 'float32-le-xyz-normal',
        recordStride: 24,
        heightUnits: 'centimeters',
        spacing: 500,
        walkableFloorZ: 0.64278764,
        walkableFloorAngle: 50,
        candidateOnly: true,
        warnings: ['Static collision only'],
        statistics: {},
        tiles: [tile],
    };
}
function binary(records = [1000, 2000, -500, 0, 0, 1, 1000, 2000, 900, 0.6, 0, 0.8]): ArrayBuffer {
    const bytes = new ArrayBuffer(records.length * 4);
    const view = new DataView(bytes);
    records.forEach((value, i) => view.setFloat32(i * 4, value, true));
    return bytes;
}
function data(): WalkabilityData {
    return { manifest: manifest(), records: new Float32Array(binary()), total: 2 };
}

test('validates JSON shape, keys, formats, normals metadata, bounds and budgets', () => {
    assert.equal(validateWalkability(manifest(), 'test').walkableFloorZ, 0.64278764);
    for (const invalid of [
        null,
        [],
        { ...manifest(), version: 2 },
        { ...manifest(), recordStride: 12 },
        { ...manifest(), recordFormat: 'float64' },
        { ...manifest(), candidateOnly: false },
        { ...manifest(), spacing: 100 },
        { ...manifest(), warnings: [1] },
        { ...manifest(), statistics: null },
        { ...manifest(), walkableFloorZ: NaN },
        { ...manifest(), walkableFloorAngle: 91 },
        { ...manifest(), tiles: [null] },
        { ...manifest(), tiles: [{ ...tile, records: MAX_TILE_BYTES }] },
        { ...manifest(), tiles: [{ ...tile, records: 1.5 }] },
        { ...manifest(), tiles: [{ ...tile, bounds: { ...tile.bounds, minX: Infinity } }] },
        { ...manifest(), tiles: [{ ...tile, bounds: { ...tile.bounds, minZ: 20000 } }] },
    ])
        assert.throws(() => validateWalkability(invalid, 'test'), /Invalid walkability/);
    assert.throws(() => validateWalkability(manifest(), 'other'), /Invalid walkability/);
});

test('little endian samples retain both floors at the same XY without mutating bytes', () => {
    const bytes = binary();
    const original = bytes.slice(0);
    const sampler = new PatchSampler();
    visitWalkability(bytes, tile, (view, offset) => sampler.add(view, offset));
    assert.deepEqual(sampler.finish(), new Float32Array(bytes));
    assert.equal(sampler.total, 2);
    assert.equal(sampler.finish()[2], -500);
    assert.equal(sampler.finish()[8], 900);
    assert.deepEqual(bytes, original);
});

test('rejects short/long binary, nonfinite/bounded coordinates, bad bounds and nonunit normals', () => {
    assert.throws(() => visitWalkability(binary().slice(1), tile, () => {}), /length/);
    assert.throws(() => visitWalkability(new ArrayBuffer(72), tile, () => {}), /length/);
    for (const [component, value] of [
        [0, NaN],
        [1, Infinity],
        [2, 1e9],
        [0, 20000],
        [5, 0],
        [3, NaN],
        [5, 1.03],
    ]) {
        const bytes = binary();
        new DataView(bytes).setFloat32(component * 4, value, true);
        assert.throws(() => visitWalkability(bytes, tile, () => {}), /coordinate|normal/);
    }
});

test('spatial thinning is bounded and tile-order independent, retaining every selected floor', () => {
    const records: number[][] = [];
    for (let x = -50; x < 50; x++)
        for (const z of [-100, 100]) records.push([x * 500, 1000, z, 0, 0, 1]);
    const sample = (rows: number[][]) => {
        const sampler = new PatchSampler(30);
        const view = new DataView(binary(rows.flat()));
        for (let i = 0; i < rows.length; i++) sampler.add(view, i * 24);
        const result = sampler.finish();
        const columns = new Map<number, number[]>();
        for (let i = 0; i < result.length; i += 6) {
            const floors = columns.get(result[i]) ?? [];
            floors.push(result[i + 2]);
            columns.set(result[i], floors);
        }
        assert.ok(result.length / 6 <= 30);
        for (const floors of columns.values())
            assert.deepEqual(
                floors.sort((a, b) => a - b),
                [-100, 100],
            );
        return [...columns.keys()].sort((a, b) => a - b);
    };
    assert.deepEqual(sample(records), sample([...records].reverse()));
    assert.ok(MAX_PATCHES <= 200_000);
});

test('shader instances use 24 byte raw xyz/normal records, tangent planes and centered exaggerated mapping', () => {
    const records = data().records;
    const original = records.slice();
    const geometry = patchGeometry(records);
    const material = patchMaterial(500, 1500, 500);
    assert.equal(geometry.instanceCount, 2);
    const position = geometry.getAttribute('sampleXYZ');
    const normal = geometry.getAttribute('sampleNormal');
    assert.equal(position.getX(0), 1000);
    assert.equal(position.getZ(0), -500);
    assert.equal(normal.getX(1), records[9]);
    assert.equal(normal.getZ(1), records[11]);
    assert.equal(material.uniforms.width.value, 425);
    assert.deepEqual(material.uniforms.center.value.toArray(), [500, 1500]);
    assert.match(material.vertexShader, /cross\(reference, n\)/);
    assert.match(material.vertexShader, /sampleXYZ \+ n \* 3.0/);
    assert.match(
        material.vertexShader,
        /vec3\(world.x - center.x, world.z, world.y - center.y\) \/ 100.0/,
    );
    assert.match(material.vertexShader, /modelViewMatrix/);
    // The parent group's Y scale applies exaggeration after cm -> centered Y-up meters.
    const centered = [5, (-500 + 3) / 100, 5];
    const layer = new WalkabilityLayer(() => {});
    layer.group.scale.y = 2;
    layer.group.updateMatrixWorld(true);
    const mapped = layer.group.localToWorld(new Vector3(...centered));
    assert.deepEqual(mapped.toArray(), [5, -9.94, 5]);
    assert.deepEqual(records, original);
    geometry.dispose();
    material.dispose();
});

test('stale completed loads and warnings are ignored after disable or map change', async () => {
    const pending: {
        resolve: (value: WalkabilityData) => void;
        signal: AbortSignal;
        warning: (m: WalkabilityManifest) => void;
    }[] = [];
    const statuses: WalkabilityStatus[] = [];
    const layer = new WalkabilityLayer(
        (status) => statuses.push(status),
        (_url, _key, signal, warning) =>
            new Promise((resolve) => pending.push({ resolve, signal, warning })),
    );
    const first = layer.enable('https://example.test/one.json', 'test', 0, 0);
    const second = layer.enable('https://example.test/two.json', 'test', 1, 2);
    assert.equal(pending[0].signal.aborted, true);
    const count = statuses.length;
    pending[0].warning(manifest());
    pending[0].resolve(data());
    await first;
    assert.equal(statuses.length, count);
    assert.equal(layer.group.children.length, 0);
    pending[1].resolve(data());
    await second;
    assert.equal(layer.group.children.length, 1);
    let geometryDisposals = 0;
    let materialDisposals = 0;
    const mesh = layer.group.children[0] as import('three').Mesh;
    mesh.geometry.addEventListener('dispose', () => geometryDisposals++);
    (mesh.material as import('three').Material).addEventListener(
        'dispose',
        () => materialDisposals++,
    );
    layer.clear();
    layer.clear();
    assert.equal(layer.group.children.length, 0);
    assert.equal(geometryDisposals, 1);
    assert.equal(materialDisposals, 1);
    const third = layer.enable('https://example.test/three.json', 'test', 0, 0);
    layer.clear();
    pending[2].resolve(data());
    await third;
    assert.equal(layer.group.children.length, 0);
});

test('coincident vertical layers exceeding the budget fail explicitly rather than truncate', () => {
    const sampler = new PatchSampler(1);
    const view = new DataView(binary([0, 0, -100, 0, 0, 1, 0, 0, 100, 0, 0, 1]));
    sampler.add(view, 0);
    assert.throws(() => sampler.add(view, 24), /coincident vertical layers/);
});

test('errors retain manifest warnings, explicitly offer retry, and successful retry cleans up', async () => {
    const statuses: WalkabilityStatus[] = [];
    let attempts = 0;
    const layer = new WalkabilityLayer(
        (status) => statuses.push(status),
        async (_url, _key, _signal, warning) => {
            warning(manifest());
            if (++attempts === 1) throw new Error('Bad binary length');
            return data();
        },
    );
    await layer.enable('https://example.test/manifest.json', 'test', 0, 0);
    assert.equal(statuses.at(-1)?.retry, true);
    assert.match(statuses.at(-1)!.text, /Bad binary length/);
    assert.deepEqual(statuses.find((s) => s.manifest)?.manifest?.warnings, [
        'Static collision only',
    ]);
    await layer.enable('https://example.test/manifest.json', 'test', 0, 0);
    assert.equal(layer.group.children.length, 1);
    assert.equal(statuses.at(-1)?.retry, undefined);
    layer.clear();
});

test('lazy loader resolves tiles relative to manifest and rejects oversized HTTP bodies', async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    try {
        globalThis.fetch = async (url, init) => {
            urls.push(String(url));
            if (urls.length % 2 === 1) assert.equal(init?.cache, 'no-store');
            return urls.length % 2 === 1
                ? new Response(JSON.stringify(manifest()))
                : new Response(binary());
        };
        const result = await loadWalkability(
            'https://example.test/terrain/walk/manifest.json',
            'test',
            new AbortController().signal,
            () => {},
        );
        assert.deepEqual(urls, [
            'https://example.test/terrain/walk/manifest.json',
            'https://example.test/terrain/walk/floors.bin',
        ]);
        assert.equal(result.records.length, 12);
        globalThis.fetch = async (url) =>
            String(url).endsWith('.json')
                ? new Response(JSON.stringify(manifest()))
                : new Response(new ArrayBuffer(49));
        await assert.rejects(
            loadWalkability(
                'https://example.test/m.json',
                'test',
                new AbortController().signal,
                () => {},
            ),
            /length\/budget/,
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});
