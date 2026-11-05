import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { cubeGridChildren, cubeGridCoordinates, cubeGridUrl } from '../src/cube-grid.js';
import { cubeMeshCounts, implicitMeshBytes } from '../src/world-mesh-fetch.js';
import {
    validateWorldModel,
    WorldModelLayer,
    type WorldBounds,
    type WorldModelStatus,
} from '../src/world-model.js';

function fixture() {
    return {
        version: 2,
        mapKey: 'Island',
        heightUnits: 'centimeters',
        meshFormat: 'awm1',
        cellSizeCm: 100,
        tileSizeCm: 12800,
        maxErrorCm: 200 * Math.sqrt(3),
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 25600, maxY: 25600, maxZ: 25600 },
        warnings: [],
        statistics: {
            hierarchyVersion: 3,
            partitionDimensions: 3,
            representation: 'blocks',
            complete: true,
            seamPolicy: 'closed-voxel-partitions-v1',
        },
        grid: {
            meshHash: 'a'.repeat(64),
            processorVersion: 'cube-grid-test-v1',
            maxLevel: 1,
            blobRoot: '../../blobs/managed/v1/',
        },
    };
}
function mesh(box: WorldBounds, size: number, empty = false): ArrayBuffer {
    const data = new ArrayBuffer(empty ? 16 : 90),
        v = new DataView(data);
    [0x314d5741, empty ? 0 : 4, empty ? 0 : 2, 0].forEach((value, i) =>
        v.setUint32(i * 4, value, true),
    );
    if (empty) return data;
    [
        box.minX,
        box.minY,
        box.minZ + size,
        box.maxX,
        box.minY,
        box.minZ + size,
        box.maxX,
        box.maxY,
        box.minZ + size,
        box.minX,
        box.maxY,
        box.minZ + size,
    ].forEach((value, i) => v.setFloat32(16 + i * 4, value, true));
    [0, 1, 2, 0, 2, 3].forEach((value, i) => v.setUint32(64 + i * 4, value, true));
    v.setUint8(88, 1);
    v.setUint8(89, 1);
    return data;
}
async function until(predicate: () => boolean) {
    const deadline = performance.now() + 5000;
    while (!predicate() && performance.now() < deadline)
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
    assert.ok(predicate(), 'Implicit grid transaction did not settle.');
}
function repeatedMesh(box: WorldBounds, size: number, triangles: number): ArrayBuffer {
    const small = mesh(box, size),
        data = new ArrayBuffer(64 + triangles * 13);
    const view = new DataView(data),
        original = new DataView(small);
    new Uint8Array(data).set(new Uint8Array(small, 0, 64));
    view.setUint32(8, triangles, true);
    for (let i = 0; i < triangles; i++) {
        for (let j = 0; j < 3; j++)
            view.setUint32(
                64 + i * 12 + j * 4,
                original.getUint32(64 + (i % 2) * 12 + j * 4, true),
                true,
            );
        view.setUint8(64 + triangles * 12 + i, 1);
    }
    return data;
}

test('implicit roots, clipped bounds and signed children are derived without a public cell index', () => {
    const raw = fixture();
    raw.bounds = {
        minX: -12800,
        minY: -12800,
        minZ: -12800,
        maxX: 12800,
        maxY: 12800,
        maxZ: 12800,
    };
    const manifest = validateWorldModel(raw, 'Island');
    assert.equal(manifest.tiles.length, 8);
    assert.ok(manifest.roots!.includes('c1_-1_-1_-1'));
    const negative = manifest.tiles.find((t) => t.id === 'c1_-1_-1_-1')!;
    assert.deepEqual(negative.bounds, {
        minX: -12800,
        maxX: 0,
        minY: -12800,
        maxY: 0,
        minZ: -12800,
        maxZ: 0,
    });
    assert.deepEqual(
        cubeGridChildren(manifest, negative).map((t) => t.id),
        ['c0_-1_-1_-1'],
    );
    assert.deepEqual(
        cubeGridChildren(
            manifest,
            manifest.tiles.find((t) => t.id === 'c1_0_0_0')!,
        ).map((t) => t.id),
        ['c0_0_0_0'],
    );
    assert.equal('tiles' in raw, false);
    assert.deepEqual(cubeGridCoordinates('c0_-14_-12_3'), [0, -14, -12, 3]);
    for (const id of ['c0_-0_1_2', 'c00_1_2_3', 'c0_01_2_3', 'c0_1_2', 'c0_1_2_3/../../secret'])
        assert.throws(() => cubeGridCoordinates(id));
});

test('deterministic names match canonical UTF8 newline recipe and change with source or processor', async () => {
    const grid = fixture().grid,
        id = 'c0_-14_-12_3',
        url = 'https://site.test/game/island/cubes.json';
    const expected = createHash('sha256')
        .update(`${grid.meshHash}\n${grid.processorVersion}\n${id}`)
        .digest('hex');
    assert.equal(
        await cubeGridUrl(grid, id, url),
        `https://site.test/blobs/managed/v1/${expected}.awm.gz`,
    );
    assert.notEqual(
        await cubeGridUrl({ ...grid, meshHash: 'b'.repeat(64) }, id, url),
        await cubeGridUrl(grid, id, url),
    );
    assert.notEqual(
        await cubeGridUrl({ ...grid, processorVersion: 'next' }, id, url),
        await cubeGridUrl(grid, id, url),
    );
});

test('implicit metadata rejects injected indexes, unsafe roots, fingerprints, versions and oversized grids', () => {
    for (const change of [
        { tiles: [] },
        { roots: [] },
        { voxelInspection: {} },
        { cellSizeCm: 50 },
        { tileSizeCm: 25600 },
        { bounds: { ...fixture().bounds, maxX: 99_993_600, maxY: 99_993_600 } },
        ...[
            { meshHash: 'no' },
            { processorVersion: 'bad\nversion' },
            { maxLevel: 7 },
            { maxLevel: 1.5 },
            { blobRoot: 'https://evil.test/meshes/' },
            { blobRoot: '../../../blobs/managed/v1/' },
            { blobRoot: 'https://arkres.blob.core.windows.net/terrain/managed/v1/?secret=x' },
        ].map((value) => ({ grid: { ...fixture().grid, ...value } })),
    ])
        assert.throws(() => validateWorldModel({ ...fixture(), ...change }, 'Island'));
});

test('empty chunks are explicit valid headers; missing, truncated and inconsistent chunks fail', async () => {
    const empty = mesh(fixture().bounds, 100, true);
    assert.deepEqual(cubeMeshCounts(empty), { vertices: 0, triangles: 0 });
    const signal = new AbortController().signal;
    await assert.rejects(
        implicitMeshBytes(
            async () => new Response(null, { status: 404 }),
            'https://site.test/a.awm.gz',
            signal,
        ),
        /HTTP 404/,
    );
    await assert.rejects(
        implicitMeshBytes(
            async () => new Response(empty, { status: 206 }),
            'https://site.test/a.awm.gz',
            signal,
        ),
        /HTTP 206/,
    );
    for (const bad of [empty.slice(0, 15), new ArrayBuffer(16), empty.slice(0)]) {
        if (bad.byteLength === 16 && new DataView(bad).getUint32(0, true) === 0x314d5741)
            new DataView(bad).setUint32(4, 3, true);
        assert.throws(() => cubeMeshCounts(bad));
    }
});

test('viewer discovers whole chunk headers, refines lazily and retains old coverage on failed children', async () => {
    const raw = fixture(),
        manifest = validateWorldModel(raw, 'Island');
    const root = manifest.tiles[0],
        children = cubeGridChildren(manifest, root);
    const bytes = new Map<string, ArrayBuffer>();
    const context = {
        url: 'https://site.test/game/island/cubes.json',
        mapKey: 'Island',
        centerX: 0,
        centerY: 0,
        mapBounds: raw.bounds,
        opacity: 1,
        exaggeration: 1,
    };
    for (const node of [root, ...children])
        bytes.set(
            await cubeGridUrl(raw.grid, node.id, context.url),
            mesh(node.bounds, node.lods[0].cubeSizeCm!, node.bounds.minZ > 0),
        );
    const calls: string[] = [];
    let failed = false,
        status: WorldModelStatus | undefined;
    const layer = new WorldModelLayer(
        (value) => {
            status = value;
        },
        async (url, init) => {
            const key = String(url);
            calls.push(key);
            assert.equal(new Headers(init?.headers).has('Range'), false);
            if (key === context.url) return new Response(JSON.stringify(raw));
            if (failed && key !== (await cubeGridUrl(raw.grid, root.id, context.url)))
                return new Response(null, { status: 404 });
            return new Response(bytes.get(key));
        },
    );
    await layer.enable(context);
    await until(() => layer.meshes.length === 1);
    assert.equal(calls.length, 2);
    const coarse = layer.meshes[0];
    const view = new THREE.PerspectiveCamera(60, 1, 0.1, 100000);
    view.position.set(128, 300, 128);
    view.lookAt(128, 0, 128);
    failed = true;
    layer.update(view, new THREE.Vector3(), 800);
    await until(() => !!status?.retry);
    assert.deepEqual(layer.meshes, [coarse]);
    assert.match(status!.text, /HTTP 404/);
    failed = false;
    layer.retry();
    layer.update(view, new THREE.Vector3(), 800);
    await until(() => layer.meshes.length === 8);
    assert.ok(!layer.meshes.includes(coarse));
    assert.ok(layer.meshes.filter((m) => !m.geometry.index!.count).length >= 4);
    layer.clear();
});

test('discovered counts block an oversized replacement until the adaptive budget grows, without redownloading cached chunks', async () => {
    const raw = fixture(),
        manifest = validateWorldModel(raw, 'Island'),
        root = manifest.tiles[0];
    const context = {
        url: 'https://site.test/game/island/cubes.json',
        mapKey: 'Island',
        centerX: 0,
        centerY: 0,
        mapBounds: raw.bounds,
        opacity: 1,
        exaggeration: 1,
    };
    const payloads = new Map<string, ArrayBuffer>();
    payloads.set(await cubeGridUrl(raw.grid, root.id, context.url), mesh(root.bounds, 200));
    for (const child of cubeGridChildren(manifest, root)) {
        payloads.set(
            await cubeGridUrl(raw.grid, child.id, context.url),
            repeatedMesh(child.bounds, 100, 150_000),
        );
    }
    let status: WorldModelStatus | undefined,
        downloads = 0;
    const layer = new WorldModelLayer(
        (value) => {
            status = value;
        },
        async (url) => {
            if (String(url) === context.url) return new Response(JSON.stringify(raw));
            downloads++;
            return new Response(payloads.get(String(url)));
        },
    );
    await layer.enable(context);
    await until(() => layer.meshes.length === 1);
    const coarse = layer.meshes[0],
        view = new THREE.PerspectiveCamera(60, 1, 0.1, 100000);
    view.position.set(128, 300, 128);
    view.lookAt(128, 0, 128);
    layer.update(view, new THREE.Vector3(), 800);
    await until(() => !!status?.text.includes('Detail blocked'));
    assert.deepEqual(layer.meshes, [coarse]);
    assert.equal(status!.retry, false);
    assert.equal(downloads, 9);
    for (let i = 0; i < 121; i++) layer.animate(1000 + i * 16);
    layer.update(view, new THREE.Vector3(), 800);
    await until(() => layer.meshes.length === 8);
    assert.equal(downloads, 9);
    layer.clear();
});

test('empty coarse chunks can refine into nonempty fine geometry', async () => {
    const raw = fixture(),
        manifest = validateWorldModel(raw, 'Island'),
        root = manifest.tiles[0];
    const context = {
        url: 'https://site.test/game/island/cubes.json',
        mapKey: 'Island',
        centerX: 0,
        centerY: 0,
        mapBounds: raw.bounds,
        opacity: 1,
        exaggeration: 1,
    };
    const payloads = new Map<string, ArrayBuffer>();
    for (const node of [root, ...cubeGridChildren(manifest, root)])
        payloads.set(
            await cubeGridUrl(raw.grid, node.id, context.url),
            mesh(node.bounds, node.lods[0].cubeSizeCm!, node.id === root.id),
        );
    const layer = new WorldModelLayer(
        () => {},
        async (url) =>
            new Response(
                String(url) === context.url ? JSON.stringify(raw) : payloads.get(String(url)),
            ),
    );
    await layer.enable(context);
    await until(() => layer.meshes.length === 1);
    assert.equal(layer.meshes[0].geometry.index!.count, 0);
    const view = new THREE.PerspectiveCamera(60, 1, 0.1, 100000);
    view.position.set(128, 300, 128);
    view.lookAt(128, 0, 128);
    layer.update(view, new THREE.Vector3(), 800);
    await until(() => layer.meshes.length === 8);
    assert.ok(layer.meshes.every((value) => value.geometry.index!.count > 0));
    layer.clear();
});

test('empty complete bases are valid but oversized discovered bases fail without partial geometry', async () => {
    for (const empty of [true, false]) {
        const raw = fixture(),
            payload = empty
                ? mesh(raw.bounds, 200, true)
                : repeatedMesh(raw.bounds, 200, 1_000_001);
        let status: WorldModelStatus | undefined;
        const layer = new WorldModelLayer(
            (value) => {
                status = value;
            },
            async (url) =>
                new Response(String(url).endsWith('.json') ? JSON.stringify(raw) : payload),
        );
        await layer.enable({
            url: 'https://site.test/game/island/cubes.json',
            mapKey: 'Island',
            centerX: 0,
            centerY: 0,
            mapBounds: raw.bounds,
            opacity: 1,
            exaggeration: 1,
        });
        await until(() => (empty ? layer.meshes.length === 1 : !!status?.retry));
        if (empty) {
            assert.equal(layer.meshes[0].geometry.index!.count, 0);
            assert.equal(layer.meshes[0].geometry.boundingSphere!.radius, 0);
        } else {
            assert.equal(layer.meshes.length, 0);
            assert.match(status!.text, /base exceeds one million/);
        }
        layer.clear();
    }
});
