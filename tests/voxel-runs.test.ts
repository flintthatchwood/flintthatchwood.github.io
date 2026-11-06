import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { decodeVoxelRuns, meshVoxelRuns, type VoxelDescriptor } from '../src/voxel-runs.js';
import { VoxelBundles, VoxelWorker } from '../src/voxel-stream.js';
import { validateWorldModel, WorldModelLayer, type WorldBounds, type WorldModelStatus } from '../src/world-model.js';

type Run = [number, number, number, number, number?];
const box: WorldBounds = { minX: -300, minY: -200, minZ: -100, maxX: 100, maxY: 100, maxZ: 500 };
function encode(runs: Run[], bounds = box): ArrayBuffer {
    const bytes = new ArrayBuffer(32 + runs.length * 6), d = new DataView(bytes);
    d.setUint32(0, 0x314c5256, true);
    [bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ, 10000]
        .forEach((value, i) => d.setUint16(4 + i * 2, value / 100, true));
    [bounds.minX, bounds.minY, bounds.minZ].forEach((v, i) => d.setInt32(12 + i * 4, v, true));
    d.setUint32(24, runs.length, true);
    runs.forEach(([x, y, z, length, flag = 0], i) => {
        d.setUint32(32 + i * 6, x | y << 8 | z << 16 | flag << 28, true);
        d.setUint16(36 + i * 6, length, true);
    });
    return bytes;
}
async function descriptor(bytes: ArrayBuffer, count: number, faces = 6): Promise<VoxelDescriptor> {
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
    return { offset: 0, length: bytes.byteLength, count, faces, bundleBytes: bytes.byteLength, sha256 };
}
function expectedFaces(runs: Run[]) {
    const solid = new Set<string>(), flags = new Map<string, number>();
    for (const [x, y, z, length, flag = 0] of runs)
        for (let k = z; k < z + length; k++) {
            solid.add(`${x},${y},${k}`);
            if (k === z + length - 1) flags.set(`${x},${y},${k}`, flag);
        }
    const faces = new Set<string>();
    for (const cell of solid) {
        const xyz = cell.split(',').map(Number);
        for (let axis = 0; axis < 3; axis++)
            for (const sign of [-1, 1]) {
                const neighbor = [...xyz]; neighbor[axis] += sign;
                if (!solid.has(neighbor.join(',')))
                    faces.add([axis, xyz[axis] + (sign > 0 ? 1 : 0), sign,
                        xyz[(axis + 1) % 3], xyz[(axis + 2) % 3], axis === 2 && sign > 0 ? flags.get(cell) ?? 0 : 0].join(','));
            }
    }
    return { faces, volume: solid.size };
}
function actualFaces(buffer: ArrayBuffer, bounds = box) {
    const d = new DataView(buffer), n = d.getUint32(4, true), triangles = d.getUint32(8, true);
    const points = Array.from({ length: n }, (_, i) =>
        [0, 1, 2].map(a => (d.getFloat32(16 + i * 12 + a * 4, true) - [bounds.minX, bounds.minY, bounds.minZ][a]) / 100));
    const faces = new Set<string>();
    let volume = 0;
    for (let i = 0; i < triangles; i++) {
        const abc = [0, 1, 2].map(j => points[d.getUint32(16 + n * 12 + i * 12 + j * 4, true)]);
        const [a, b, c] = abc.map(p => new THREE.Vector3(...p));
        volume += a.dot(b.clone().cross(c)) / 6;
        if (i % 2) continue;
        const normal = b.clone().sub(a).cross(c.clone().sub(a)).toArray();
        const axis = normal.findIndex(v => v !== 0), sign = Math.sign(normal[axis]);
        const more = [0, 1, 2].map(j => points[d.getUint32(16 + n * 12 + (i + 1) * 12 + j * 4, true)]);
        const corners = [...abc, ...more], u = (axis + 1) % 3, v = (axis + 2) % 3;
        const flag = d.getUint8(16 + n * 12 + triangles * 12 + i);
        for (let x = Math.min(...corners.map(p => p[u])); x < Math.max(...corners.map(p => p[u])); x++)
            for (let y = Math.min(...corners.map(p => p[v])); y < Math.max(...corners.map(p => p[v])); y++) {
                const face = [axis, abc[0][axis], sign, x, y, flag].join(',');
                assert.ok(!faces.has(face), 'No duplicate external unit face');
                faces.add(face);
            }
    }
    return { faces, volume };
}

test('greedy closed meshing matches exact oriented boundary sets and signed solid volume', () => {
    const fixtures: Run[][] = [
        [], [[0, 0, 0, 6, 1]], [[0, 0, 0, 1], [1, 0, 2, 3, 1]],
        [[0, 0, 0, 4], [1, 0, 1, 2], [2, 0, 0, 1], [2, 0, 3, 3, 1]],
        [[0, 0, 0, 1], [0, 0, 2, 1], [0, 0, 4, 1], [1, 0, 1, 1], [1, 0, 3, 1], [1, 0, 5, 1]],
    ];
    let seed = 1987;
    for (let t = 0; t < 30; t++) {
        const runs: Run[] = [];
        for (let y = 0; y < 3; y++)
            for (let x = 0; x < 4; x++) {
                const occupied: boolean[] = [];
                for (let z = 0; z < 6; z++) { seed = (seed * 1664525 + 1013904223) >>> 0; occupied.push((seed >>> 28) < 9); }
                for (let z = 0; z < 6; z++) if (occupied[z]) {
                    const start = z;
                    while (z + 1 < 6 && occupied[z + 1]) z++;
                    runs.push([x, y, start, z - start + 1, Number(z === 5)]);
                }
            }
        fixtures.push(runs);
    }
    for (const runs of fixtures) {
        const result = meshVoxelRuns(encode(runs), box, runs.length);
        const expected = expectedFaces(runs), actual = actualFaces(result.bytes);
        assert.deepEqual(actual.faces, expected.faces);
        assert.ok(Math.abs(actual.volume - expected.volume) < 1e-8);
        assert.equal(result.unitFaces, expected.faces.size);
    }
    assert.equal(meshVoxelRuns(encode([[0, 0, 0, 6]]), box, 1).triangles, 12);
});

test('decoder rejects malformed counts, reserved bits, adjacent runs and off-grid bounds', () => {
    const valid = encode([[0, 0, 0, 1]]);
    for (const at of [0, 4, 10, 24, 28, 32, 35, 36]) {
        const copy = valid.slice(0); new Uint8Array(copy)[at] = 255;
        assert.throws(() => decodeVoxelRuns(copy, box, 1));
    }
    assert.throws(() => decodeVoxelRuns(valid.slice(0, -1), box, 1));
    assert.throws(() => decodeVoxelRuns(encode([[0, 0, 0, 1], [0, 0, 1, 1]]), box, 2));
    assert.throws(() => decodeVoxelRuns(valid, { ...box, minX: box.minX + 1 }, 1));
    const edgeBox = { minX: 0, minY: 0, minZ: 0, maxX: 12800, maxY: 12800, maxZ: 409500 };
    assert.equal(meshVoxelRuns(encode([[127, 127, 4094, 1, 1]], edgeBox), edgeBox, 1).triangles, 12);
});

test('bundle requests deduplicate, authenticate, survive one consumer abort, and evict by decoded bytes', async () => {
    const bytes = encode([[0, 0, 0, 1]]), d = await descriptor(bytes, 1);
    let calls = 0, finish!: (response: Response) => void;
    const cache = new VoxelBundles(async () => { calls++; return new Promise(resolve => { finish = resolve; }); }, bytes.byteLength);
    const a = new AbortController(), b = new AbortController(), url = new URL('https://test.invalid/bundle');
    const first = cache.get(url, d, box, a.signal), second = cache.get(url, d, box, b.signal);
    a.abort();
    await assert.rejects(first, /abort/i);
    finish(new Response(bytes)); assert.deepEqual(await second, bytes);
    await cache.get(url, d, box, b.signal);
    assert.equal(calls, 1); assert.equal(cache.residentBytes, bytes.byteLength);
    cache.setBudget(0); assert.equal(cache.residentBytes, 0);
    cache.clear();
    const bad = new VoxelBundles(async () => new Response(bytes), bytes.byteLength);
    await assert.rejects(bad.get(url, { ...d, sha256: '0'.repeat(64) }, box, b.signal), /SHA-256/);
    assert.equal(bad.residentBytes, 0); bad.clear();
});

test('unshared cancelled bundles abort transport and stale completion cannot enter the cache', async () => {
    const bytes = encode([[0, 0, 0, 1]]), d = await descriptor(bytes, 1);
    let transport: AbortSignal | undefined, finish!: (response: Response) => void;
    const cache = new VoxelBundles(async (_url, init) => {
        transport = init?.signal ?? undefined;
        return new Promise(resolve => { finish = resolve; });
    }, 1000);
    const controller = new AbortController();
    const pending = cache.get(new URL('https://test.invalid/a'), d, box, controller.signal);
    controller.abort(); await assert.rejects(pending);
    assert.ok(transport?.aborted);
    finish(new Response(bytes));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cache.residentBytes, 0);
    cache.clear();
});

test('voxel metadata, shared bundle rendering, occupancy inspection and lifecycle retain existing geometry behavior', async () => {
    const bounds = { minX: 0, minY: 0, minZ: 0, maxX: 25600, maxY: 100, maxZ: 300 };
    const boxes = [0, 1].map(x => ({ ...bounds, minX: x * 12800, maxX: (x + 1) * 12800 }));
    const chunks = boxes.map(b => encode([[0, 0, 0, 1, 1]], b));
    const joined = new Uint8Array(76); joined.set(new Uint8Array(chunks[0])); joined.set(new Uint8Array(chunks[1]), 38);
    const d = await descriptor(joined.buffer, 1);
    const manifest = {
        version: 3, mapKey: 'Island', heightUnits: 'centimeters', meshFormat: 'vrl1', cellSizeCm: 100,
        tileSizeCm: 12800, maxErrorCm: 0, bounds, warnings: [],
        statistics: { representation: 'voxel-runs', complete: true, geometry: 'closed-solid' },
        tiles: boxes.map((b, i) => ({ id: String(i), bounds: b, lods: [{
            url: `bundles/${d.sha256}.vrb.gz`, vertices: 24, triangles: 12, maxErrorCm: 0,
            voxel: { ...d, offset: i * 38, length: 38 },
        }] })),
    };
    validateWorldModel(manifest, 'Island');
    const published = structuredClone(manifest);
    for (const tile of published.tiles) tile.lods[0].url =
        `https://arkres.blob.core.windows.net/terrain/managed/v1/${'a'.repeat(64)}.vrb.gz`;
    validateWorldModel(published, 'Island');
    const untrusted = structuredClone(published);
    untrusted.tiles[0].lods[0].url = `https://example.invalid/${'a'.repeat(64)}.vrb.gz`;
    assert.throws(() => validateWorldModel(untrusted, 'Island'), /voxel-run/);
    const malformed = structuredClone(manifest); malformed.tiles[0].lods[0].voxel.length++;
    assert.throws(() => validateWorldModel(malformed, 'Island'), /voxel-run/);
    const statuses: WorldModelStatus[] = [];
    let requests = 0, disposed = false;
    const layer = new WorldModelLayer(status => statuses.push(status),
        async url => String(url).endsWith('.json') ? Response.json(manifest) : (requests++, new Response(joined)),
        () => ({ mesh: async (bytes, b, count) => meshVoxelRuns(bytes, b, count), dispose: () => { disposed = true; } }));
    await layer.enable({ url: 'https://test.invalid/world.json', mapKey: 'Island', centerX: 0, centerY: 0, mapBounds: bounds });
    const camera = new THREE.OrthographicCamera(-200, 200, 200, -200, .1, 1000);
    camera.position.set(128, 300, 0); camera.up.set(0, 0, -1); camera.lookAt(128, 0, 0);
    layer.update(camera, new THREE.Vector3(128, 0, 0), 800);
    for (let i = 0; i < 100 && layer.meshes.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(layer.meshes.length, 2, statuses.at(-1)?.text);
    assert.equal(requests, 1);
    for (const mesh of layer.meshes) {
        assert.ok(Array.isArray(mesh.material));
        for (const group of mesh.geometry.groups) assert.ok(mesh.material[group.materialIndex!]);
    }
    layer.group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(.5, .5, -1), new THREE.Vector3(0, 0, 1));
    assert.ok(ray.intersectObjects(layer.meshes).length > 0, 'Closed side faces remain pickable.');
    assert.equal(layer.cubeSizeCm(layer.meshes[0]), 100);
    assert.equal(await layer.voxelFill({ minX: 0, minY: 0, minZ: 0, maxX: 100, maxY: 100, maxZ: 100 }, new AbortController().signal), 1);
    for (const x of [200, 0]) {
        camera.left = -20; camera.right = 20; camera.updateProjectionMatrix();
        camera.position.set(x, 300, 0); camera.lookAt(x, 0, 0);
        layer.update(camera, new THREE.Vector3(x, 0, 0), 800);
        for (let i = 0; i < 100 && layer.meshes.length !== 1; i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(layer.meshes.length, 1);
    }
    assert.equal(requests, 1, 'Geometry eviction does not evict the packed bundle.');
    layer.setBudgetMultiplier(32); layer.setBudgetMultiplier(1);
    assert.match(statuses.at(-1)!.text, /Closed voxel terrain.*Packed voxel cache/);
    layer.clear(); assert.ok(disposed); assert.equal(layer.meshes.length, 0);
});

test('active worker cancellation terminates stale computation but preserves queued consumers', async () => {
    class FakeWorker extends EventTarget {
        static workers: FakeWorker[] = [];
        sent?: { id: number };
        terminated = false;
        constructor() { super(); FakeWorker.workers.push(this); }
        postMessage(message: { id: number }) { this.sent = message; }
        terminate() { this.terminated = true; }
    }
    const oldWorker = globalThis.Worker, oldDocument = globalThis.document;
    Object.defineProperty(globalThis, 'Worker', { value: FakeWorker, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'document', { value: { baseURI: 'https://test.invalid/' }, configurable: true, writable: true });
    const worker = new VoxelWorker(), a = new AbortController(), b = new AbortController();
    try {
        const bytes = encode([[0, 0, 0, 1]]);
        const first = worker.mesh(bytes.slice(0), box, 1, a.signal), second = worker.mesh(bytes.slice(0), box, 1, b.signal);
        a.abort(); await assert.rejects(first);
        assert.ok(FakeWorker.workers[0].terminated);
        const active = FakeWorker.workers[1], mesh = meshVoxelRuns(bytes, box, 1);
        active.dispatchEvent(new MessageEvent('message', { data: { id: active.sent!.id, mesh } }));
        assert.equal((await second).triangles, 12);
    } finally {
        worker.dispose();
        Object.defineProperty(globalThis, 'Worker', { value: oldWorker, configurable: true, writable: true });
        Object.defineProperty(globalThis, 'document', { value: oldDocument, configurable: true, writable: true });
    }
});

test('a large unit-face estimate cannot starve greedily compact chunks at the default budget', async () => {
    const bounds = { minX: 0, minY: 0, minZ: 0, maxX: 12800, maxY: 100, maxZ: 332800 };
    const runs: Run[] = Array.from({ length: 128 }, (_, x) => [x, 0, 0, 3328]);
    const bytes = encode(runs, bounds), faces = 2 * (128 + 3328 + 128 * 3328), d = await descriptor(bytes, 128, faces);
    const manifest = {
        version: 3, mapKey: 'Island', heightUnits: 'centimeters', meshFormat: 'vrl1', cellSizeCm: 100,
        tileSizeCm: 12800, maxErrorCm: 0, bounds, warnings: [],
        statistics: { representation: 'voxel-runs', complete: true, geometry: 'closed-solid' },
        tiles: [{ id: 'large', bounds, lods: [{ url: `bundles/${d.sha256}.vrb.gz`,
            vertices: faces * 4, triangles: faces * 2, maxErrorCm: 0, voxel: d }] }],
    };
    const statuses: WorldModelStatus[] = [];
    const layer = new WorldModelLayer(status => statuses.push(status),
        async url => String(url).endsWith('.json') ? Response.json(manifest) : new Response(bytes),
        () => ({ mesh: async (bytes, b, count) => meshVoxelRuns(bytes, b, count), dispose() {} }));
    try {
        await layer.enable({ url: 'https://test.invalid/world.json', mapKey: 'Island', centerX: 0, centerY: 0, mapBounds: bounds });
        const camera = new THREE.OrthographicCamera(-200, 200, 200, -200, .1, 10000);
        camera.position.set(64, 4000, 0); camera.up.set(0, 0, -1); camera.lookAt(64, 0, 0);
        layer.update(camera, new THREE.Vector3(64, 0, 0), 800);
        for (let i = 0; i < 100 && !layer.meshes.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(layer.meshes.length, 1, statuses.at(-1)?.text);
        assert.equal(layer.meshes[0].geometry.index!.count / 3, 12);
    } finally { layer.clear(); }
});
