import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
    WorldModelLayer,
    validateWorldModel,
    worldGeometry,
    worldGeometryBytes,
    worldBinaryBytes,
    type WorldModelManifest,
    type WorldModelStatus,
} from '../src/world-model.js';
import { attachWorldMorph, cubeSizeFactors, morphWeight, ProgressiveWorld } from '../src/progressive-world.js';

test('adaptive shrink coarsens progressively even when one sibling group cannot meet the new target', async () => {
    const nodes = [0, 1].flatMap(root => {
        const bounds = { minX: root * 200, maxX: (root + 1) * 200, minY: 0, maxY: 200, minZ: 0, maxZ: 200 };
        const node = (id: string, b: typeof bounds, triangles: number, size: number, children: string[] = []) => ({
            id, bounds: b, children,
            lods: [{ url: `${id}.awm`, vertices: 3, triangles, cubeSizeCm: size, maxErrorCm: size }],
        });
        return [
            node(`r${root}`, bounds, 1, 200, [`a${root}`, `b${root}`]),
            node(`a${root}`, { ...bounds, maxX: bounds.minX + 100 }, 140_000, 100),
            node(`b${root}`, { ...bounds, minX: bounds.minX + 100 }, 140_000, 100),
        ];
    });
    const manifest: WorldModelManifest = {
        version: 1, mapKey: 'Island', meshFormat: 'awm1', heightUnits: 'centimeters',
        cellSizeCm: 100, tileSizeCm: 200, maxErrorCm: 200,
        bounds: { ...nodes[0].bounds, maxX: 400 }, warnings: [],
        statistics: { hierarchyVersion: 3 }, roots: ['r0', 'r1'], tiles: nodes,
    };
    const request: typeof fetch = async url => {
        const node = nodes.find(n => new URL(String(url)).pathname === `/${n.id}.awm`)!;
        const count = node.lods[0].triangles, data = new ArrayBuffer(52 + count * 13), view = new DataView(data);
        [0x314d5741, 3, count, 0].forEach((value, i) => view.setUint32(i * 4, value, true));
        [node.bounds.minX, 0, 0, node.bounds.maxX, 0, 0, node.bounds.minX, 200, 0]
            .forEach((value, i) => view.setFloat32(16 + i * 4, value, true));
        for (let i = 0; i < count; i++) {
            view.setUint32(52 + i * 12 + 4, 1, true);
            view.setUint32(52 + i * 12 + 8, 2, true);
        }
        return new Response(data);
    };
    const material = new THREE.MeshBasicMaterial(), time = { value: 1 };
    const world = new ProgressiveWorld(manifest, {
        url: 'https://test.invalid/cubes.json', centerX: 0, centerY: 0, mapBounds: manifest.bounds,
    }, request, new THREE.Group(), geometry => new THREE.Mesh(geometry, material), time, () => undefined);
    const view = new THREE.PerspectiveCamera(90, 1, .1, 10000);
    view.position.set(2, 10, 1);
    view.lookAt(2, 0, 1);
    world.start();
    await until(() => world.meshes.length === 2);
    world.update(view, 800, 1);
    await until(() => world.meshes.length === 3);
    world.update(view, 800, 1);
    await until(() => world.meshes.length === 4);
    for (let i = 0; i < 721; i++) {
        time.value += .03;
        world.animate();
    }
    world.update(view, 800, 1);
    await until(() => world.meshes.length === 3);
    world.update(view, 800, 1);
    await until(() => world.meshes.length === 2);
    world.clear();
    material.dispose();
});

const box = { minX: 0, minY: 0, minZ: 100, maxX: 100, maxY: 100, maxZ: 100 };
function fixture(): WorldModelManifest {
    return {
        version: 1,
        mapKey: 'Island',
        meshFormat: 'awm1',
        heightUnits: 'centimeters',
        cellSizeCm: 50,
        tileSizeCm: 100,
        maxErrorCm: 50,
        bounds: box,
        warnings: [],
        statistics: { representation: 'progressive', hierarchyVersion: 1 },
        roots: ['root'],
        tiles: ['root', 'a', 'b'].map((id) => ({
            id,
            bounds: box,
            children: id === 'root' ? ['a', 'b'] : [],
            lods: [
                {
                    url: id + '.awp',
                    vertices: 3,
                    triangles: 1,
                    maxErrorCm: id === 'root' ? 50 : 0,
                    morph: true,
                },
            ],
        })),
    };
}
function binary(id: string): ArrayBuffer {
    const points =
        id === 'root'
            ? [0, 0, 100, 100, 0, 100, 0, 100, 100]
            : id === 'a'
              ? [0, 0, 100, 100, 0, 100, 50, 50, 100]
              : [0, 0, 100, 50, 50, 100, 0, 100, 100];
    const coarse =
        id === 'a' ? [0, 0, 100, 100, 0, 100, 100, 0, 100] : [0, 0, 100, 100, 0, 100, 0, 100, 100];
    const buffer = new ArrayBuffer(101),
        v = new DataView(buffer);
    [0x31505741, 3, 1, 0].forEach((value, i) => v.setUint32(i * 4, value, true));
    points.forEach((value, i) => v.setFloat32(16 + i * 4, value, true));
    [0, 1, 2].forEach((value, i) => v.setUint32(52 + i * 4, value, true));
    v.setUint8(64, 3);
    coarse.forEach((value, i) => v.setFloat32(65 + i * 4, value, true));
    return buffer;
}
async function until(predicate: () => boolean) {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.ok(predicate(), 'progressive state did not settle');
}
const context = {
    url: 'https://test.invalid/world.json',
    mapKey: 'Island',
    centerX: 0,
    centerY: 0,
    mapBounds: box,
};

test('a failed 3D base leaves no surface and retry can load it without stale geometry', async () => {
    const statuses: WorldModelStatus[] = [];
    let fail = true;
    const request: typeof fetch = async (url) => {
        if (String(url).endsWith('.json')) return new Response(JSON.stringify(fixture()));
        return fail ? new Response('missing', { status: 404 }) : new Response(binary('root'));
    };
    const layer = new WorldModelLayer((status) => statuses.push(status), request);
    await layer.enable(context);
    await until(() => !!statuses.at(-1)?.retry);
    assert.equal(layer.meshes.length, 0);
    assert.match(statuses.at(-1)!.text, /No 3D base loaded/);
    fail = false;
    layer.retry();
    await until(() => layer.meshes.length === 1);
    layer.clear();
    assert.equal(layer.meshes.length, 0);
});
function camera(height: number) {
    const c = new THREE.PerspectiveCamera(42, 1, 0.01, 1000000);
    c.position.set(0.5, height, 0.5);
    c.lookAt(0.5, 1, 0.5);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    return c;
}

test('perspective dolly streams triangle children and retains complete coverage during swaps', async () => {
    const request: typeof fetch = async (url) =>
        String(url).endsWith('.json')
            ? new Response(JSON.stringify(fixture()))
            : new Response(binary(new URL(String(url)).pathname.slice(1, -4)));
    const layer = new WorldModelLayer(() => undefined, request);
    const view = camera(10000);
    await layer.enable(context);
    await until(() => layer.meshes.length === 1);
    layer.animate(1000);
    layer.update(view, new THREE.Vector3(0.5, 1, 0.5), 800);
    assert.equal(layer.meshes.length, 1);
    view.position.y = 2;
    layer.update(view, new THREE.Vector3(0.5, 1, 0.5), 800);
    assert.equal(layer.meshes.length, 1, 'Parent stays visible while children load.');
    await until(() => layer.meshes.length === 2);
    layer.animate(1500);
    view.position.y = 10000;
    layer.update(view, new THREE.Vector3(0.5, 1, 0.5), 800);
    assert.equal(layer.meshes.length, 2, 'Children stay visible while parent loads.');
    let time = 2000;
    await until(() => {
        layer.animate(time);
        time += 300;
        return layer.meshes.length === 1;
    });
    assert.equal(layer.meshes.length, 1);
    layer.clear();
});

test('picking follows morphed positions without intersecting the wireframe helper', async () => {
    const manifest = fixture();
    manifest.bounds = { ...box, maxZ: 200 };
    for (const node of manifest.tiles) node.bounds = manifest.bounds;
    const request: typeof fetch = async (url) => {
        if (String(url).endsWith('.json')) return new Response(JSON.stringify(manifest));
        const id = new URL(String(url)).pathname.slice(1, -4);
        const bytes = binary(id);
        if (id !== 'root') {
            const view = new DataView(bytes);
            for (let vertex = 0; vertex < 3; vertex++)
                view.setFloat32(16 + vertex * 12 + 8, 200, true);
        }
        return new Response(bytes);
    };
    const layer = new WorldModelLayer(() => undefined, request);
    await layer.enable(context);
    await until(() => layer.meshes.length === 1);
    layer.animate(1000);
    layer.update(camera(10), new THREE.Vector3(), 800);
    await until(() => layer.meshes.length === 2);
    for (const [time, height] of [
        [1000, 1],
        [1125, 1.5],
        [1250, 2],
    ]) {
        layer.animate(time);
        layer.group.updateMatrixWorld(true);
        const hits = new THREE.Raycaster(
            new THREE.Vector3(0.1, 10, 0.3),
            new THREE.Vector3(0, -1, 0),
        ).intersectObjects(layer.meshes);
        assert.ok(hits.length > 0);
        assert.ok(hits.every((hit) => layer.meshes.includes(hit.object as THREE.Mesh)));
        assert.ok(Math.abs(hits[0].point.y - height) < 1e-6);
    }
    layer.clear();
});

test('hierarchy validation rejects cycles, missing/shared nodes, bad bounds, correspondence and oversized bases', () => {
    assert.equal(validateWorldModel(fixture(), 'Island').roots?.[0], 'root');
    const certified = fixture();
    certified.statistics.hierarchyVersion = 2;
    certified.statistics.seamPolicy = 'fixed-interface-collar-v1';
    assert.equal(validateWorldModel(certified, 'Island').statistics.hierarchyVersion, 2);
    for (const change of [
        (m: WorldModelManifest) => {
            m.statistics.hierarchyVersion = 3;
        },
        (m: WorldModelManifest) => {
            m.statistics.hierarchyVersion = 2;
        },
        (m: WorldModelManifest) => {
            m.statistics.hierarchyVersion = 2;
            m.statistics.seamPolicy = 'vertices-only';
        },
        (m: WorldModelManifest) => {
            m.tiles[1].children = ['root'];
        },
        (m: WorldModelManifest) => {
            m.tiles[0].children = ['missing'];
        },
        (m: WorldModelManifest) => {
            m.tiles[0].children = ['a', 'a'];
        },
        (m: WorldModelManifest) => {
            m.tiles[1].bounds = { ...box, maxX: 101 };
        },
        (m: WorldModelManifest) => {
            m.tiles[1].lods[0].maxErrorCm = 51;
        },
        (m: WorldModelManifest) => {
            m.tiles[1].lods[0].morph = false;
        },
        (m: WorldModelManifest) => {
            m.tiles[0].lods[0].triangles = 1000001;
        },
    ]) {
        const m = fixture();
        change(m);
        assert.throws(() => validateWorldModel(m, 'Island'));
    }
});

test('seam certification needs a common root; legacy forests remain readable', () => {
    const m = fixture();
    m.roots = ['root', 'a', 'b'];
    m.tiles[0].children = [];
    assert.doesNotThrow(() => validateWorldModel(m, 'Island'));
    m.statistics.hierarchyVersion = 2;
    m.statistics.seamPolicy = 'fixed-interface-collar-v1';
    assert.throws(() => validateWorldModel(m, 'Island'), /Invalid progressive roots/);
});

function cubeFixture(): WorldModelManifest {
    const m = fixture();
    m.cellSizeCm = 400;
    m.tileSizeCm = 800;
    m.bounds = { minX: 0, minY: 0, minZ: 800, maxX: 800, maxY: 800, maxZ: 800 };
    m.statistics = { representation: 'blocks', hierarchyVersion: 3, complete: true,
        seamPolicy: 'closed-voxel-partitions-v1' };
    for (const node of m.tiles) {
        node.bounds = m.bounds;
        delete node.lods[0].morph;
        node.lods[0].cubeSizeCm = node.id === 'root' ? 800 : 400;
    }
    return m;
}

function cubeBinary(id: string): ArrayBuffer {
    const bytes = binary(id).slice(0, 65);
    const v = new DataView(bytes);
    v.setUint32(0, 0x314d5741, true);
    for (let i = 0; i < 9; i++) v.setFloat32(16 + i * 4, v.getFloat32(16 + i * 4, true) * 8, true);
    return bytes;
}

function budgetMeshBinary(template: ArrayBuffer, vertices: number, triangles: number, morph = false): ArrayBuffer {
    const bytes = new ArrayBuffer(16 + vertices * (morph ? 24 : 12) + triangles * 13);
    const v = new DataView(bytes), source = new DataView(template);
    [source.getUint32(0, true), vertices, triangles, 0].forEach((value, i) => v.setUint32(i * 4, value, true));
    for (let i = 0; i < vertices; i++)
        for (let axis = 0; axis < 3; axis++) {
            v.setFloat32(16 + i * 12 + axis * 4, source.getFloat32(16 + i % 3 * 12 + axis * 4, true), true);
            if (morph)
                v.setFloat32(16 + vertices * 12 + triangles * 13 + i * 12 + axis * 4,
                    source.getFloat32(65 + i % 3 * 12 + axis * 4, true), true);
        }
    for (let i = 0; i < triangles; i++) {
        for (let axis = 0; axis < 3; axis++)
            v.setUint32(16 + vertices * 12 + i * 12 + axis * 4, source.getUint32(52 + axis * 4, true), true);
        v.setUint8(16 + vertices * 12 + triangles * 12 + i, source.getUint8(64));
    }
    return bytes;
}

for (const kind of ['cubes', 'triangles'] as const)
    for (const constraint of ['triangles', 'bytes'] as const)
        test(`runtime ${kind} budget admits more ${constraint} and coarsens without holes when lowered`, async () => {
            const m = kind === 'cubes' ? cubeFixture() : fixture();
            for (const node of m.tiles.filter(node => node.id !== 'root')) {
                node.lods[0].triangles = constraint === 'triangles' ? 600_000 : 1;
                node.lods[0].vertices = constraint === 'bytes'
                    ? kind === 'cubes' ? 1_600_000 : 1_000_000 : 3;
            }
            const statuses: WorldModelStatus[] = [];
            const layer = new WorldModelLayer(status => statuses.push(status), async url => {
                if (String(url).endsWith('.json')) return Response.json(m);
                const id = new URL(String(url)).pathname.slice(1, -4);
                const lod = m.tiles.find(node => node.id === id)!.lods[0];
                return new Response(budgetMeshBinary(kind === 'cubes' ? cubeBinary(id) : binary(id),
                    lod.vertices, lod.triangles, lod.morph));
            });
            await layer.enable({ ...context, mapBounds: m.bounds });
            await until(() => layer.meshes.length === 1);
            layer.animate(1000);
            const target = new THREE.Vector3(), view = camera(10);
            layer.update(view, target, 800);
            assert.equal(layer.meshes.length, 1);
            layer.setBudgetMultiplier(2);
            assert.equal(layer.meshes.length, 1, 'The complete parent remains until both children arrive.');
            await until(() => layer.meshes.length === 2);
            layer.animate(1500);
            let disposed = 0;
            for (const mesh of layer.meshes) mesh.geometry.addEventListener('dispose', () => disposed++);
            layer.setBudgetMultiplier(1);
            assert.equal(layer.meshes.length, 2, 'The complete old frontier remains during coarsening.');
            let now = 2000;
            await until(() => {
                layer.animate(now += 300);
                return layer.meshes.length === 1;
            });
            assert.equal(disposed, 2);
            assert.equal(layer.meshes[0].geometry.index!.count / 3, 1);
            assert.equal(statuses.at(-1)!.retry, false);
            assert.match(statuses.at(-1)!.text, /96 MiB/);
            layer.clear();
        });

test('budget changes abort partial seam-bearing replacements and cannot commit stale children', async () => {
    const m = cubeFixture();
    const signals: AbortSignal[] = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const statuses: WorldModelStatus[] = [];
    const material = new THREE.MeshBasicMaterial();
    const time = { value: 1 };
    const world = new ProgressiveWorld(m, { ...context, mapBounds: m.bounds }, async (url, init) => {
        const id = new URL(String(url)).pathname.slice(1, -4);
        if (id === 'b') {
            signals.push(init!.signal!);
            await held;
        }
        return new Response(cubeBinary(id));
    }, new THREE.Group(), geometry => new THREE.Mesh(geometry, material), time,
    status => statuses.push(status));
    world.start();
    await until(() => world.meshes.length === 1);
    const root = world.meshes[0];
    world.setBudgetMultiplier(2);
    world.update(camera(10), 800, 1);
    await until(() => world.allMeshes.length === 2 && signals.length === 1);
    let disposed = 0;
    world.allMeshes.find(mesh => mesh !== root)!.geometry.addEventListener('dispose', () => disposed++);
    world.setBudgetMultiplier(1);
    assert.equal(signals[0].aborted, true);
    assert.equal(disposed, 1);
    assert.deepEqual(world.meshes, [root]);
    release!();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(world.meshes, [root]);
    assert.equal(world.allMeshes.length, 1);
    assert.equal(statuses.at(-1)!.retry, false);
    world.clear();
    material.dispose();
});

test('spatial cube roots can stack vertically but cannot overlap in volume', () => {
    const m = cubeFixture();
    m.statistics.partitionDimensions = 3;
    m.bounds = { ...m.bounds, minZ: 0, maxZ: 1600 };
    m.roots = ['a', 'b'];
    m.tiles = m.tiles.filter(t => t.id !== 'root');
    m.tiles[0].bounds = { ...m.bounds, maxZ: 800 };
    m.tiles[1].bounds = { ...m.bounds, minZ: 800 };
    assert.equal(validateWorldModel(m, 'Island').roots!.length, 2);
    m.tiles[1].bounds.minZ = 799;
    assert.throws(() => validateWorldModel(m, 'Island'), /Overlapping complete-base/);
});

test('packed mesh descriptors require safe paired ranges and the bundle extension', () => {
    const m = cubeFixture();
    const lod = m.tiles[0].lods[0];
    lod.url = 'packed.awmb';
    lod.byteOffset = 0;
    lod.byteLength = 100;
    assert.equal(validateWorldModel(m, 'Island').tiles[0].lods[0].byteLength, 100);
    for (const change of [
        () => { lod.byteOffset = undefined; },
        () => { lod.byteOffset = -1; },
        () => { lod.byteOffset = Number.MAX_SAFE_INTEGER; },
        () => { lod.url = 'not-a-bundle.awm.gz'; },
    ]) {
        lod.byteOffset = 0;
        lod.url = 'packed.awmb';
        change();
        assert.throws(() => validateWorldModel(m, 'Island'));
    }
});

test('mesh inspection reports resident one- and four-metre blocks, not requested sizes or retired meshes', async () => {
    for (const size of [100, 400]) {
        const m = cubeFixture();
        m.cellSizeCm = size;
        for (const node of m.tiles) node.lods[0].cubeSizeCm = node.id === 'root' ? size * 2 : size;
        const request: typeof fetch = async url => String(url).endsWith('.json')
            ? new Response(JSON.stringify(m))
            : new Response(cubeBinary(new URL(String(url)).pathname.slice(1, -4)));
        const layer = new WorldModelLayer(() => undefined, request);
        await layer.enable({ ...context, mapBounds: m.bounds });
        await until(() => layer.meshes.length === 1);
        const root = layer.meshes[0];
        assert.equal(layer.cubeSizeCm(root), size * 2);
        assert.equal(layer.cubeSizeCm(new THREE.Mesh()), undefined);
        layer.animate(1000);
        layer.update(camera(10), new THREE.Vector3(), 800);
        await until(() => layer.meshes.length === 2);
        assert.equal(layer.cubeSizeCm(root), undefined);
        for (const mesh of layer.meshes) assert.equal(layer.cubeSizeCm(mesh), size);
        const child = layer.meshes[0];
        layer.clear();
        assert.equal(layer.cubeSizeCm(child), undefined);
    }
});

test('one- and two-metre cube hierarchies accept local bases and content-addressed Azure refinements', () => {
    for (const size of [100, 200]) {
        const m = cubeFixture();
        m.cellSizeCm = size;
        for (const node of m.tiles) node.lods[0].cubeSizeCm = node.id === 'root' ? size * 2 : size;
        const blobUrl = `https://arkres.blob.core.windows.net/terrain/managed/v1/${'a'.repeat(64)}.awm`;
        m.tiles[1].lods[0].url = blobUrl;
        assert.equal(validateWorldModel(m, 'Island').tiles[1].lods[0].url, blobUrl);
        assert.equal(new URL(blobUrl, 'https://site.test/terrain/cubes.json').href, blobUrl);
        for (const invalidUrl of [
            blobUrl.replace('https:', 'http:'),
            blobUrl.replace('arkres.', 'user:password@arkres.'),
            `${blobUrl}?token=secret`,
            `${blobUrl}#fragment`,
            blobUrl.replace('/managed/', '/unmanaged/'),
        ]) {
            m.tiles[1].lods[0].url = invalidUrl;
            assert.throws(() => validateWorldModel(m, 'Island'));
        }
    }
    const layer = new WorldModelLayer(() => {});
    for (const factor of [1, 2, 4, 8, 16, 32, 64]) layer.setCubeSizeFactors(factor, factor);
    for (const factor of [0, 3, 128, NaN, Infinity]) {
        assert.throws(() => layer.setCubeSizeFactors(1, factor));
        assert.throws(() => layer.setCubeSizeFactors(factor, 64));
    }
    assert.throws(() => layer.setCubeSizeFactors(8, 4), /Near cube minimum/);
    layer.clear();
});

test('linked cube size factors keep Near at or below Far and the changed slider wins', () => {
    assert.deepEqual(cubeSizeFactors(8, 4, 'far'), { near: 4, far: 4 });
    assert.deepEqual(cubeSizeFactors(8, 4, 'near'), { near: 8, far: 8 });
    for (const changed of ['near', 'far'] as const) {
        assert.deepEqual(cubeSizeFactors(2, 8, changed), { near: 2, far: 8 });
        assert.deepEqual(cubeSizeFactors(4, 4, changed), { near: 4, far: 4 });
    }
});

test('cube hierarchy schema has fixed sizes and no morph correspondence', () => {
    const m = cubeFixture();
    assert.equal(validateWorldModel(m, 'Island').tiles[0].lods[0].cubeSizeCm, 800);
    for (const change of [
        (m: WorldModelManifest) => { m.statistics.seamPolicy = 'fixed-interface-collar-v1'; },
        (m: WorldModelManifest) => { m.tiles[1].lods[0].cubeSizeCm = 800; },
        (m: WorldModelManifest) => { m.tiles[1].lods[0].cubeSizeCm = 500; },
        (m: WorldModelManifest) => { m.tiles[1].lods[0].morph = true; },
    ]) {
        const invalid = cubeFixture();
        change(invalid);
        assert.throws(() => validateWorldModel(invalid, 'Island'));
    }
    const geometry = worldGeometry(cubeBinary('root'), m.tiles[0].lods[0], m.bounds, 0, 0, m.bounds, true);
    geometry.dispose();
    const calibratedImage = { ...m.bounds, minX: -1.25, minY: -2.5, maxX: 801.75, maxY: 802.25 };
    const mapped = worldGeometry(cubeBinary('root'), m.tiles[0].lods[0], m.bounds, 0, 0, calibratedImage, true);
    mapped.dispose();
    const bad = cubeBinary('root');
    new DataView(bad).setFloat32(16, 100, true);
    assert.throws(() => worldGeometry(bad, m.tiles[0].lods[0], m.bounds, 0, 0, m.bounds, true), /lattice/);
    const tilted = cubeBinary('root');
    new DataView(tilted).setFloat32(36, 1600, true);
    assert.throws(() => worldGeometry(tilted, m.tiles[0].lods[0],
        { ...m.bounds, minZ: 0, maxZ: 1600 }, 0, 0, m.bounds, true), /axis-aligned/);
});

test('cubes retain their whole base during delayed loads and swap without morphing; slider coarsens live', async () => {
    const m = cubeFixture();
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const request: typeof fetch = async url => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('.json')) return new Response(JSON.stringify(m));
        const id = path.slice(1, -4);
        if (id === 'b') await held;
        return new Response(cubeBinary(id));
    };
    const layer = new WorldModelLayer(() => undefined, request);
    await layer.enable({ ...context, mapBounds: m.bounds });
    await until(() => layer.meshes.length === 1);
    const root = layer.meshes[0];
    layer.animate(1000);
    layer.update(camera(10), new THREE.Vector3(), 800);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(layer.meshes[0], root);
    release!();
    await until(() => layer.meshes.length === 2);
    for (const mesh of layer.meshes) {
        assert.equal(mesh.geometry.getAttribute('worldCoarsePosition'), undefined);
        assert.equal(mesh.geometry.getAttribute('worldPatchTransition'), undefined);
    }
    layer.group.updateMatrixWorld(true);
    assert.ok(new THREE.Raycaster(new THREE.Vector3(.2, 10, .2), new THREE.Vector3(0, -1, 0))
        .intersectObjects(layer.meshes, false).length);
    layer.animate(1500);
    layer.setCubeSizeFactors(1, 1);
    layer.update(camera(10000), new THREE.Vector3(), 800);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(layer.meshes.length, 2);
    layer.setCubeSizeFactors(1, 2);
    layer.update(camera(10000), new THREE.Vector3(), 800);
    await until(() => layer.meshes.length === 1);
    assert.throws(() => layer.setCubeSizeFactors(1, 3), /Invalid far cube/);
    layer.clear();
});

test('near cube minimum limits close-up refinement and coarsens already-loaded nearby meshes', async () => {
    const m = cubeFixture();
    const requested: string[] = [];
    const statuses: WorldModelStatus[] = [];
    const request: typeof fetch = async url => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('.json')) return new Response(JSON.stringify(m));
        const id = path.slice(1, -4);
        requested.push(id);
        return new Response(cubeBinary(id));
    };
    const layer = new WorldModelLayer(status => statuses.push(status), request);
    layer.setCubeSizeFactors(2, 2);
    await layer.enable({ ...context, mapBounds: m.bounds });
    await until(() => layer.meshes.length === 1);
    layer.animate(1000);
    layer.update(camera(10), new THREE.Vector3(), 800);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(requested, ['root']);
    assert.match(statuses.at(-1)!.text, /8\.00 m nearby target; far target 8\.00 m/);
    layer.setCubeSizeFactors(1, 2);
    layer.update(camera(10), new THREE.Vector3(), 800);
    await until(() => layer.meshes.length === 2);
    layer.animate(1500);
    layer.setCubeSizeFactors(2, 2);
    layer.update(camera(10), new THREE.Vector3(), 800);
    await until(() => layer.meshes.length === 1);
    layer.clear();
});

test('AWP correspondence is bounded and budgets include every GPU morph attribute', () => {
    const lod = fixture().tiles[1].lods[0],
        buffer = binary('a');
    const g = worldGeometry(buffer, lod, box, 0, 0, box);
    assert.equal(worldBinaryBytes(lod), 101);
    assert.equal(
        Object.values(g.attributes).reduce((n, a) => n + a.array.byteLength, 0) +
            g.index!.array.byteLength,
        worldGeometryBytes(lod),
    );
    assert.equal(g.getAttribute('worldCoarsePosition').getX(2), 1);
    const bad = buffer.slice(0);
    new DataView(bad).setFloat32(65, NaN, true);
    assert.throws(() => worldGeometry(bad, lod, box, 0, 0, box));
    const outside = buffer.slice(0);
    new DataView(outside).setFloat32(65, 200, true);
    assert.throws(() => worldGeometry(outside, lod, box, 0, 0, box));
    g.dispose();
});

test('GPU morph injection composes with surface shading and varies positions and calibrated UVs', () => {
    const material = new THREE.MeshBasicMaterial();
    material.onBeforeCompile = (shader) => {
        shader.vertexShader += '\nworldColorPosition = position;';
    };
    const time = { value: 0 };
    attachWorldMorph(material, time, box, 0, 0);
    attachWorldMorph(material, time, box, 0, 0);
    const shader = {
        uniforms: {},
        vertexShader: '#include <common>\n#include <uv_vertex>\n#include <begin_vertex>',
        fragmentShader: '',
    };
    material.onBeforeCompile(shader as THREE.Shader, {} as THREE.WebGLRenderer);
    assert.equal(
        (shader.vertexShader.match(/attribute vec3 worldCoarsePosition/g) ?? []).length,
        1,
    );
    assert.match(shader.vertexShader, /worldColorPosition = transformed/);
    assert.match(shader.vertexShader, /vUv = .*worldMorphUv/);
    assert.equal(Reflect.get(shader.uniforms, 'worldMorphTime'), time);
    assert.equal(morphWeight(1, 1, 1), 0);
    assert.equal(morphWeight(1, 1, 1.125), 0.5);
    assert.equal(morphWeight(1, -1, 1.125), 0.5);
    assert.equal(morphWeight(1, -1, 1.25), 0);
});

test('complete parents remain until every child is ready; GPU morphing does not rewrite positions', async () => {
    const statuses: WorldModelStatus[] = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const request: typeof fetch = async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('.json')) return new Response(JSON.stringify(fixture()));
        const id = path.slice(1, -4);
        if (id === 'b') await held;
        return new Response(binary(id));
    };
    const layer = new WorldModelLayer((s) => statuses.push(s), request);
    await layer.enable(context);
    await until(() => layer.meshes.length === 1);
    const root = layer.meshes[0];
    layer.animate(1000);
    layer.update(camera(10), new THREE.Vector3(), 800);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(layer.meshes[0], root);
    release!();
    await until(() => layer.meshes.length === 2);
    const child = layer.meshes[0],
        positions = [...child.geometry.getAttribute('position').array];
    layer.animate(1125);
    assert.deepEqual([...child.geometry.getAttribute('position').array], positions);
    layer.animate(1500);
    layer.update(camera(10000), new THREE.Vector3(), 800);
    await until(() => statuses.at(-1)?.text.includes('Streaming') ?? false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    layer.animate(2000);
    assert.equal(layer.meshes.length, 1);
    layer.clear();
});

test('failed children retain the complete 3D parent, report retry and never restore the heightfield', async () => {
    const statuses: WorldModelStatus[] = [];
    let fail = true;
    const request: typeof fetch = async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('.json')) return new Response(JSON.stringify(fixture()));
        const id = path.slice(1, -4);
        if (id === 'b' && fail) return new Response('missing', { status: 404 });
        return new Response(binary(id));
    };
    const layer = new WorldModelLayer((s) => statuses.push(s), request);
    await layer.enable(context);
    await until(() => layer.meshes.length === 1);
    const root = layer.meshes[0];
    layer.animate(1000);
    layer.update(camera(10), new THREE.Vector3(), 800);
    await until(() => !!statuses.at(-1)?.retry);
    assert.equal(layer.meshes[0], root);
    fail = false;
    layer.retry();
    layer.update(camera(10), new THREE.Vector3(), 800);
    await until(() => layer.meshes.length === 2);
    layer.clear();
});

test('a failed coarsening request does not retry every selection tick', async () => {
    const statuses: WorldModelStatus[] = [];
    let roots = 0;
    let fail = true;
    const request: typeof fetch = async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('.json')) return new Response(JSON.stringify(fixture()));
        const id = path.slice(1, -4);
        if (id === 'root' && ++roots > 1 && fail) return new Response('missing', { status: 404 });
        return new Response(binary(id));
    };
    const layer = new WorldModelLayer((status) => statuses.push(status), request);
    await layer.enable(context);
    await until(() => layer.meshes.length === 1);
    layer.animate(1000);
    layer.update(camera(10), new THREE.Vector3(), 800);
    await until(() => layer.meshes.length === 2);
    layer.animate(1500);
    layer.update(camera(10000), new THREE.Vector3(), 800);
    await until(() => !!statuses.at(-1)?.retry);
    for (let i = 0; i < 10; i++) {
        layer.update(camera(10000), new THREE.Vector3(), 800);
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(roots, 2);
    assert.equal(layer.meshes.length, 2);
    fail = false;
    layer.retry();
    layer.update(camera(10000), new THREE.Vector3(), 800);
    await until(() => roots === 3);
    await new Promise<void>((resolve) => setImmediate(resolve));
    layer.animate(2000);
    assert.equal(layer.meshes.length, 1);
    layer.clear();
});

for (const constraint of ['triangles', 'bytes']) {
    test(`a stationary camera never reclaims detail for a refinement that cannot fit the ${constraint} budget`, async () => {
        const m = fixture();
        const template = m.tiles[0];
        m.roots = ['high', 'low'];
        m.tiles = ['high', 'high-a', 'high-b', 'low', 'low-a', 'low-b'].map((id) => ({
            ...template,
            id,
            children: id.includes('-') ? [] : [`${id}-a`, `${id}-b`],
            lods: [
                {
                    ...template.lods[0],
                    url: id + '.awp',
                    triangles: id.startsWith('high-') && constraint === 'triangles' ? 600_000 : 1,
                    vertices: id.startsWith('high-') && constraint === 'bytes' ? 1_000_000 : 3,
                    maxErrorCm: id === 'high' ? 1000 : id === 'low' ? 100 : 0,
                },
            ],
        }));
        const requested: string[] = [];
        const layer = new WorldModelLayer(
            () => undefined,
            async (url) => {
                const path = new URL(String(url)).pathname;
                if (path.endsWith('.json')) return new Response(JSON.stringify(m));
                const id = path.slice(1, -4);
                requested.push(id);
                return new Response(
                    binary(id.endsWith('-a') ? 'a' : id.endsWith('-b') ? 'b' : 'root'),
                );
            },
        );
        await layer.enable(context);
        await until(() => layer.meshes.length === 2);
        const steady = camera(10);
        for (let tick = 0; tick < 40; tick++) {
            layer.animate(1000 + tick * 500);
            layer.update(steady, new THREE.Vector3(), 800);
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        assert.deepEqual(requested, ['high', 'low', 'low-a', 'low-b']);
        assert.equal(layer.meshes.length, 3);
        layer.clear();
    });
}

test('budget reclamation plans multiple lower-priority coarsenings before refining and then settles', async () => {
    const m = fixture();
    m.roots = ['high', 'low', 'other'];
    m.bounds = { ...box, maxX: 10100 };
    const template = m.tiles[0];
    m.tiles = m.roots.flatMap((root) =>
        [root, root + '-a', root + '-b'].map((id) => {
            const origin = root === 'high' ? 10000 : root === 'other' ? 200 : 0;
            return {
                ...template,
                id,
                bounds: { ...box, minX: origin, maxX: origin + 100 },
                children: id === root ? [root + '-a', root + '-b'] : [],
                lods: [
                    {
                        ...template.lods[0],
                        url: id + '.awp',
                        triangles: id === root ? 1 : root === 'high' ? 475_000 : 50_000,
                        maxErrorCm: id === root ? (root === 'high' ? 50 : 100) : 0,
                    },
                ],
            };
        }),
    );
    const requested: string[] = [];
    const layer = new WorldModelLayer(
        () => undefined,
        async (url) => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith('.json')) return new Response(JSON.stringify(m));
            const id = path.slice(1, -4);
            requested.push(id);
            const node = m.tiles.find((node) => node.id === id)!;
            const count = node.lods[0].triangles;
            const data = new ArrayBuffer(88 + count * 13);
            const v = new DataView(data);
            [0x31505741, 3, count, 0].forEach((value, i) => v.setUint32(i * 4, value, true));
            const points = [0, 0, 100, 100, 0, 100, 0, 100, 100];
            points.forEach((value, i) => {
                const position = value + (i % 3 === 0 ? node.bounds.minX : 0);
                v.setFloat32(16 + i * 4, position, true);
                v.setFloat32(52 + count * 13 + i * 4, position, true);
            });
            for (let i = 0; i < count; i++) {
                v.setUint32(52 + i * 12 + 4, 1, true);
                v.setUint32(52 + i * 12 + 8, 2, true);
            }
            return new Response(data);
        },
    );
    await layer.enable({ ...context, mapBounds: m.bounds });
    await until(() => layer.meshes.length === 3);
    const nearLow = camera(10);
    for (let tick = 0; tick < 8; tick++) {
        layer.animate(1000 + tick * 500);
        layer.update(nearLow, new THREE.Vector3(), 800);
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(layer.meshes.length, 5);
    const nearHigh = camera(10);
    nearHigh.position.x += 100;
    nearHigh.lookAt(100.5, 1, 0.5);
    nearHigh.updateMatrixWorld();
    for (let tick = 0; tick < 30; tick++) {
        layer.animate(10000 + tick * 500);
        layer.update(nearHigh, new THREE.Vector3(100, 0, 0), 800);
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(layer.meshes.length, 4);
    assert.deepEqual(requested.slice(-4), ['low', 'other', 'high-a', 'high-b']);
    assert.equal(requested.length, 11);
    layer.clear();
});
