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
import { attachWorldMorph, morphWeight } from '../src/progressive-world.js';

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

test('orthographic zoom streams triangle children and retains complete coverage during swaps', async () => {
    const request: typeof fetch = async (url) =>
        String(url).endsWith('.json')
            ? new Response(JSON.stringify(fixture()))
            : new Response(binary(new URL(String(url)).pathname.slice(1, -4)));
    const layer = new WorldModelLayer(() => undefined, request);
    const view = new THREE.OrthographicCamera(-1000, 1000, 1000, -1000, 0.01, 1000000);
    view.position.set(0.5, 10000, 0.5);
    view.lookAt(0.5, 1, 0.5);
    await layer.enable(context);
    await until(() => layer.meshes.length === 1);
    layer.animate(1000);
    layer.update(view, new THREE.Vector3(0.5, 1, 0.5), 800);
    assert.equal(layer.meshes.length, 1);
    view.zoom = 1000;
    view.updateProjectionMatrix();
    layer.update(view, new THREE.Vector3(0.5, 1, 0.5), 800);
    assert.equal(layer.meshes.length, 1, 'Parent stays visible while children load.');
    await until(() => layer.meshes.length === 2);
    layer.animate(1500);
    view.zoom = 1;
    view.updateProjectionMatrix();
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
    for (const factor of [1, 2, 4, 8, 16, 32, 64]) layer.setCubeSizeFactor(factor);
    for (const factor of [0, 3, 128]) assert.throws(() => layer.setCubeSizeFactor(factor));
    layer.clear();
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
    layer.setCubeSizeFactor(1);
    layer.update(camera(10000), new THREE.Vector3(), 800);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(layer.meshes.length, 2);
    layer.setCubeSizeFactor(2);
    layer.update(camera(10000), new THREE.Vector3(), 800);
    await until(() => layer.meshes.length === 1);
    assert.throws(() => layer.setCubeSizeFactor(3), /Invalid far cube/);
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
