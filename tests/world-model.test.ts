import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
    validateWorldModel,
    worldGeometry,
    worldGeometryBytes,
    selectWorldTiles,
    WorldModelLayer,
    WORLD_TRIANGLES,
    WORLD_RESIDENT_BYTES,
    type WorldModelManifest,
    type WorldModelStatus,
} from '../src/world-model.js';

const mapBounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
function fixture(): WorldModelManifest {
    return {
        version: 1,
        mapKey: 'Island',
        heightUnits: 'centimeters',
        meshFormat: 'awm1',
        cellSizeCm: 50,
        tileSizeCm: 100,
        maxErrorCm: 25,
        bounds: { minX: 0, minY: 0, minZ: 100, maxX: 200, maxY: 100, maxZ: 100 },
        warnings: ['Synthetic fixture'],
        statistics: {},
        tiles: [0, 1].map((column) => ({
            id: String(column),
            bounds: {
                minX: column * 100,
                minY: 0,
                minZ: 100,
                maxX: (column + 1) * 100,
                maxY: 100,
                maxZ: 100,
            },
            lods: [{ url: `${column}.awm`, vertices: 3, triangles: 1, maxErrorCm: 25 }],
        })),
    };
}
function binary(column = 0, flag = 3): ArrayBuffer {
    const data = new ArrayBuffer(65),
        view = new DataView(data);
    [0x314d5741, 3, 1, 0].forEach((value, i) => view.setUint32(i * 4, value, true));
    [column * 100, 0, 100, (column + 1) * 100, 0, 100, column * 100, 100, 100].forEach((value, i) =>
        view.setFloat32(16 + i * 4, value, true),
    );
    [0, 1, 2].forEach((value, i) => view.setUint32(52 + i * 4, value, true));
    view.setUint8(64, flag);
    return data;
}
function blockFixture(): { manifest: WorldModelManifest; data: ArrayBuffer } {
    const manifest = fixture();
    manifest.statistics.representation = 'blocks';
    manifest.bounds.minZ = 0;
    manifest.tiles = manifest.tiles.slice(0, 1);
    manifest.tiles[0].bounds.minZ = 0;
    Object.assign(manifest.tiles[0].lods[0], { vertices: 12, triangles: 4 });
    const data = new ArrayBuffer(212),
        view = new DataView(data);
    [0x314d5741, 12, 4, 0].forEach((value, i) => view.setUint32(i * 4, value, true));
    const faces = [
        [0, 0, 100, 100, 0, 100, 0, 100, 100],
        [0, 0, 0, 0, 100, 0, 0, 100, 100],
        [0, 0, 0, 100, 0, 0, 100, 0, 100],
        [0, 0, 0, 100, 0, 0, 0, 100, 0],
    ];
    faces.flat().forEach((value, i) => view.setFloat32(16 + i * 4, value, true));
    for (let i = 0; i < 12; i++) view.setUint32(160 + i * 4, i, true);
    [1, 0, 0, 0].forEach((flag, i) => view.setUint8(208 + i, flag));
    return { manifest, data };
}
function view(): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
    camera.position.set(1, 10, 0.5);
    camera.lookAt(1, 1, 0.5);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    return camera;
}
async function until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.ok(predicate(), 'async state did not settle');
}

test('world manifests require exact identity, bounded LODs and nominal nonoverlapping footprints', () => {
    assert.equal(validateWorldModel(fixture(), 'Island').tiles.length, 2);
    for (const change of [
        (m: WorldModelManifest) => {
            m.mapKey = 'Other';
        },
        (m: WorldModelManifest) => {
            m.tiles = [];
        },
        (m: WorldModelManifest) => {
            m.tiles[0].bounds.maxX = 99;
        },
        (m: WorldModelManifest) => {
            m.tiles[1].bounds = m.tiles[0].bounds;
        },
        (m: WorldModelManifest) => {
            m.tiles[0].lods[0].vertices = 10_000_000;
        },
        (m: WorldModelManifest) => {
            m.tiles[0].lods[0].url = 'https://other.invalid/tile';
        },
        (m: WorldModelManifest) => {
            m.tiles[0].lods[0].url = '../tile';
        },
        (m: WorldModelManifest) => {
            m.tiles[0].lods[0].url = ' //other.invalid/tile';
        },
        (m: WorldModelManifest) => {
            m.tiles[0].lods[0].url = 'ht\ttps://other.invalid/tile';
        },
        (m: WorldModelManifest) => {
            m.tiles[0].lods.push({ ...m.tiles[0].lods[0], maxErrorCm: 0 });
        },
    ]) {
        const m = fixture();
        change(m);
        assert.throws(() => validateWorldModel(m, 'Island'));
    }
});

test('AWM1 preserves world coordinates, image UVs, outward winding and original source flags', () => {
    const tile = fixture().tiles[0],
        original = binary(),
        copy = original.slice(0);
    for (let flag = 0; flag < 4; flag++) {
        const geometry = worldGeometry(binary(0, flag), tile.lods[0], tile.bounds, 0, 0, mapBounds);
        assert.deepEqual([...geometry.getAttribute('position').array], [0, 1, 0, 1, 1, 0, 0, 1, 1]);
        assert.deepEqual([...geometry.getAttribute('uv').array], [0, 1, 0.5, 1, 0, 0]);
        assert.deepEqual([...geometry.index!.array], [0, 2, 1]);
        assert.equal(geometry.getAttribute('normal').getY(0), 1);
        assert.deepEqual(geometry.groups, [{ start: 0, count: 3, materialIndex: flag }]);
        geometry.dispose();
    }
    worldGeometry(original, tile.lods[0], tile.bounds, 0, 0, mapBounds).dispose();
    assert.deepEqual(original, copy);
});

test('valid source triangles survive sub-pixel Float32 meter rounding without rejecting their tile', () => {
    const data = binary();
    const view = new DataView(data);
    view.setFloat32(16, 130000.0078125, true);
    view.setFloat32(28, 130000.015625, true);
    view.setFloat32(40, 130000.0078125, true);
    const box = { minX: 130000, maxX: 130100, minY: 0, maxY: 100, minZ: 100, maxZ: 100 };
    const geometry = worldGeometry(data, fixture().tiles[0].lods[0], box, 0, 0, box);
    assert.equal(
        geometry.getAttribute('position').getX(0),
        geometry.getAttribute('position').getX(1),
    );
    assert.equal(geometry.index!.count, 3);
    assert.ok([...geometry.getAttribute('normal').array].every(Number.isFinite));
    geometry.dispose();
});

test('block sides stretch edge UVs vertically without texturing undersides or changing mesh classification', () => {
    const { manifest, data } = blockFixture(),
        tile = manifest.tiles[0],
        original = data.slice(0);
    const geometry = worldGeometry(data, tile.lods[0], tile.bounds, 0, 0, mapBounds, true);
    assert.deepEqual(geometry.groups, [
        { start: 0, count: 3, materialIndex: 0 },
        { start: 3, count: 3, materialIndex: 1 },
        { start: 6, count: 6, materialIndex: 4 },
    ]);
    const uv = geometry.getAttribute('uv');
    for (const [bottom, top] of [
        [4, 5],
        [7, 8],
    ]) {
        assert.equal(uv.getX(bottom), uv.getX(top));
        assert.equal(uv.getY(bottom), uv.getY(top));
    }
    assert.deepEqual([uv.getX(4), uv.getY(4)], [0, 0]);
    assert.deepEqual([uv.getX(7), uv.getY(7)], [0.5, 1]);
    assert.equal(geometry.index!.count, 12);
    assert.equal(
        Object.values(geometry.attributes).reduce((sum, a) => sum + a.array.byteLength, 0) +
            geometry.index!.array.byteLength,
        worldGeometryBytes(tile.lods[0]),
    );
    const mesh = worldGeometry(data, tile.lods[0], tile.bounds, 0, 0, mapBounds);
    assert.deepEqual(mesh.groups, [
        { start: 0, count: 9, materialIndex: 0 },
        { start: 9, count: 3, materialIndex: 1 },
    ]);
    assert.deepEqual(
        [...mesh.getAttribute('position').array],
        [...geometry.getAttribute('position').array],
    );
    assert.deepEqual(data, original);
    geometry.dispose();
    mesh.dispose();
});

test('AWM1 rejects wrong lengths, headers, counts, reserved bits, vertices, indices and flags', () => {
    const tile = fixture().tiles[0];
    for (const [offset, value, kind] of [
        [0, 0, 'uint'],
        [4, 4, 'uint'],
        [8, 2, 'uint'],
        [12, 1, 'uint'],
        [16, NaN, 'float'],
        [16, 101, 'float'],
        [52, 3, 'uint'],
        [56, 0, 'uint'],
        [64, 4, 'byte'],
    ] as const) {
        const buffer = binary(),
            v = new DataView(buffer);
        if (kind === 'float') v.setFloat32(offset, value, true);
        else if (kind === 'byte') v.setUint8(offset, value);
        else v.setUint32(offset, value, true);
        assert.throws(() => worldGeometry(buffer, tile.lods[0], tile.bounds, 0, 0, mapBounds));
    }
    assert.throws(() =>
        worldGeometry(new ArrayBuffer(0), tile.lods[0], tile.bounds, 0, 0, mapBounds),
    );
    const collapsed = binary();
    new DataView(collapsed).setFloat32(16 + 6 * 4, 100, true);
    new DataView(collapsed).setFloat32(16 + 7 * 4, 0, true);
    assert.throws(
        () => worldGeometry(collapsed, tile.lods[0], tile.bounds, 0, 0, mapBounds),
        /Degenerate/,
    );
});

test('one continuous tile retains stacked cave floors at identical XY, including negative heights', () => {
    const lod = { url: 'stacked.awm', vertices: 6, triangles: 2, maxErrorCm: 0 };
    const buffer = new ArrayBuffer(114),
        v = new DataView(buffer);
    [0x314d5741, 6, 2, 0].forEach((value, i) => v.setUint32(i * 4, value, true));
    let offset = 16;
    for (const z of [100, -100])
        for (const value of [0, 0, z, 100, 0, z, 0, 100, z]) {
            v.setFloat32(offset, value, true);
            offset += 4;
        }
    for (const value of [0, 1, 2, 3, 4, 5]) {
        v.setUint32(offset, value, true);
        offset += 4;
    }
    v.setUint8(offset++, 3);
    v.setUint8(offset, 2);
    const tile = fixture().tiles[0];
    const geometry = worldGeometry(buffer, lod, { ...tile.bounds, minZ: -100 }, 0, 0, mapBounds);
    const positions = geometry.getAttribute('position');
    assert.equal(positions.count, 6);
    assert.equal(positions.getX(0), positions.getX(3));
    assert.equal(positions.getZ(0), positions.getZ(3));
    assert.equal(positions.getY(0), 1);
    assert.equal(positions.getY(3), -1);
    assert.deepEqual(geometry.groups, [
        { start: 0, count: 3, materialIndex: 2 },
        { start: 3, count: 3, materialIndex: 3 },
    ]);
    assert.equal(geometry.index!.count, 6);
    geometry.dispose();
});

test('camera LOD selects whole tiles under exact triangle and resident-byte limits, never face samples', () => {
    const m = fixture(),
        camera = view(),
        target = new THREE.Vector3(1, 1, 0.5);
    m.tiles.forEach((tile) =>
        tile.lods.unshift({
            url: 'fine.awm',
            vertices: 300,
            triangles: 100,
            maxErrorCm: 0,
        }),
    );
    const selected = selectWorldTiles(m, camera, target, 800, 1, 0, 0, 2, 1000);
    assert.equal(selected.length, 2);
    assert.ok(selected.every((selection) => selection.lod === 1));
    const single = selectWorldTiles(m, camera, target, 800, 1, 0, 0, 1, 1000);
    assert.equal(single.length, 1);
    assert.ok(single.every((selection) => selection.tile.lods[selection.lod].triangles <= 1));
    const none = selectWorldTiles(
        m,
        camera,
        target,
        800,
        1,
        0,
        0,
        2,
        worldGeometryBytes(m.tiles[0].lods[1]) - 1,
    );
    assert.equal(none.length, 0);
});

test('default budgets enforce exactly one million triangles and 96 MiB of resident attributes', () => {
    const m = fixture(),
        camera = view(),
        target = new THREE.Vector3(1, 1, 0.5);
    m.tiles.forEach((tile) => {
        tile.lods[0].triangles = WORLD_TRIANGLES + 1;
    });

    test('streaming spends a limited budget near the camera, not at a distant orbit target', () => {
        const m = fixture();
        m.bounds = { minX: 0, minY: 0, minZ: 0, maxX: 2000, maxY: 100, maxZ: 100 };
        m.tiles = [0, 1000].map((x, index) => ({
            id: String(index),
            bounds: { minX: x, minY: 0, minZ: 0, maxX: x + 100, maxY: 100, maxZ: 100 },
            lods: [{ url: `${index}.awm`, vertices: 3, triangles: 1, maxErrorCm: 0 }],
        }));
        const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
        camera.position.set(-1, 0.5, 0.5);
        camera.lookAt(20, 0.5, 0.5);
        camera.updateProjectionMatrix();
        for (const distance of [2, 20, 11000]) {
            const selected = selectWorldTiles(
                m,
                camera,
                new THREE.Vector3(distance, 0.5, 0.5),
                800,
                1,
                0,
                0,
                1,
                1000,
            );
            assert.deepEqual(
                selected.map((item) => item.tile.id),
                ['0'],
            );
        }
    });
    assert.equal(selectWorldTiles(m, camera, target, 800, 1, 0, 0).length, 0);
    m.tiles.forEach((tile) => {
        tile.lods[0].triangles = WORLD_TRIANGLES;
    });
    assert.equal(selectWorldTiles(m, camera, target, 800, 1, 0, 0).length, 1);
    const prototype = fixture().tiles[0];
    m.bounds.maxX = 400;
    m.tiles = Array.from({ length: 4 }, (_, column) => ({
        ...prototype,
        id: String(column),
        bounds: { ...prototype.bounds, minX: column * 100, maxX: (column + 1) * 100 },
        lods: [{ url: `${column}.awm`, vertices: 1_048_576, triangles: 1, maxErrorCm: 25 }],
    }));
    assert.equal(WORLD_RESIDENT_BYTES, 96 * 1024 * 1024);
    assert.equal(selectWorldTiles(m, camera, target, 800, 1, 0, 0).length, 2);
    m.tiles.forEach((tile) => {
        tile.lods[0].vertices--;
    });
    assert.equal(selectWorldTiles(m, camera, target, 800, 1, 0, 0).length, 3);
});

test('world layer loads lazily, averages covered colors, and preserves shared texture', async () => {
    const m = fixture();
    m.tiles = m.tiles.slice(0, 1);
    const statuses: WorldModelStatus[] = [],
        urls: string[] = [],
        texture = new THREE.DataTexture(new Uint8Array(7 * 5 * 4).fill(255), 7, 5);
    let disposed = false;
    texture.addEventListener('dispose', () => {
        disposed = true;
    });
    const request: typeof fetch = async (url, options) => {
        urls.push(String(url));
        if (String(url).endsWith('world.json')) {
            assert.equal(options?.cache, 'no-store');
            return Response.json(m);
        }
        return new Response(binary());
    };
    const layer = new WorldModelLayer((status) => statuses.push(status), request);
    assert.equal(urls.length, 0);
    await layer.enable({
        url: 'https://assets.test/world.json',
        mapKey: 'Island',
        centerX: 0,
        centerY: 0,
        mapBounds,
        texture,
    });
    assert.equal(urls.length, 1);
    layer.update(view(), new THREE.Vector3(1, 1, 0.5), 800);
    await until(() => layer.meshes.length === 1);
    const mesh = layer.meshes[0];
    assert.ok(Array.isArray(mesh.material));
    const materials = mesh.material as THREE.MeshPhongMaterial[];
    assert.equal(materials[0].map, texture);
    assert.equal(materials[0].color.getHexString(), 'ffffff');
    assert.equal(materials[1].map, texture);
    for (const index of [0, 2]) {
        const shader = {
            uniforms: {},
            vertexShader: THREE.ShaderLib.phong.vertexShader,
            fragmentShader: THREE.ShaderLib.phong.fragmentShader,
        };
        materials[index].onBeforeCompile(shader as THREE.Shader, {} as THREE.WebGLRenderer);
        const uniform = Reflect.get(shader.uniforms, 'worldColorTexel');
        assert.deepEqual(uniform.value.toArray(), [1 / 7, 1 / 5]);
        assert.match(shader.vertexShader, /worldColorPosition = position/);
        assert.match(shader.fragmentShader, /for \(int y = -2; y <= 2; y\+\+\)/);
        assert.match(shader.fragmentShader, /for \(int x = -2; x <= 2; x\+\+\)/);
        assert.match(shader.fragmentShader, /nearbyColor \+= mapTexelToLinear/);
        assert.match(shader.fragmentShader, /floor\(vUv \/ worldColorTexel\)/);
        assert.match(shader.fragmentShader, /sampleUv = clamp\(centerUv/);
        assert.match(shader.fragmentShader, /cross\(dFdx\(worldColorPosition\), dFdy/);
        assert.match(shader.fragmentShader, /gl_FrontFacing \? 1.0 : -1.0/);
        assert.match(shader.fragmentShader, /0.60 \+ 0.25 \* clamp\(upward, -1.0, 1.0\)/);
        assert.match(shader.fragmentShader, /nearbyColor.rgb \/ 25.0 \* surfaceLightness/);
        assert.match(shader.fragmentShader, /#include <lights_phong_fragment>/);
        assert.equal(materials[index].customProgramCacheKey(), 'world-nearby-color-v3');
    }
    assert.notEqual(materials[1].customProgramCacheKey(), 'world-nearby-color-v3');
    layer.setAppearance({
        lighting: true,
        exaggeration: 2,
        opacity: 0.2,
        slopes: true,
        wireframe: true,
        cutHeightCm: 50,
    });
    assert.equal(materials[0].opacity, 1);
    assert.equal(materials[1].opacity, 0.2);
    assert.equal(materials[2].color.getHexString(), '3edc65');
    assert.equal(materials[3].color.getHexString(), '3edc65');
    assert.equal(materials[0].polygonOffset, true);
    assert.equal(layer.group.scale.y, 2);
    assert.equal(layer.clipPlane.constant, 1);
    assert.equal(mesh.children[0].visible, true);
    layer.setAppearance({
        lighting: false,
        exaggeration: 2,
        opacity: 0.2,
        slopes: true,
        wireframe: true,
        cutHeightCm: 50,
    });
    assert.ok(Array.isArray(mesh.material));
    assert.ok(mesh.material[0] instanceof THREE.MeshBasicMaterial);
    assert.equal(mesh.material[0].map, texture);
    assert.equal(mesh.material[0].customProgramCacheKey(), 'world-nearby-color-v3');
    const basicShader = {
        uniforms: {},
        vertexShader: THREE.ShaderLib.basic.vertexShader,
        fragmentShader: THREE.ShaderLib.basic.fragmentShader,
    };
    mesh.material[0].onBeforeCompile(basicShader as THREE.Shader, {} as THREE.WebGLRenderer);
    assert.match(basicShader.fragmentShader, /nearbyColor.rgb \/ 25.0 \* surfaceLightness/);
    assert.equal(basicShader.fragmentShader.includes('#include <map_fragment>'), false);
    const mapped = mesh.material[3];
    assert.ok(mapped instanceof THREE.MeshBasicMaterial);
    assert.equal(mapped.map, texture);
    assert.match(statuses.at(-1)!.text, /unloaded areas remain empty/);
    layer.clear();
    assert.equal(layer.meshes.length, 0);
    assert.equal(disposed, false);
});

test('block walls and undersides average the shared map with independent opacity, lighting and clipping', async () => {
    const { manifest, data } = blockFixture(),
        texture = new THREE.DataTexture(new Uint8Array(4 * 3 * 4).fill(255), 4, 3);
    const request: typeof fetch = async (url) =>
        String(url).endsWith('world.json') ? Response.json(manifest) : new Response(data);
    const layer = new WorldModelLayer(() => {}, request);
    const context = {
        url: 'https://assets.test/world.json',
        mapKey: 'Island',
        centerX: 0,
        centerY: 0,
        mapBounds,
    };
    await layer.enable({ ...context, texture });
    layer.update(view(), new THREE.Vector3(1, 1, 0.5), 800);
    await until(() => layer.meshes.length === 1);
    for (const lighting of [true, false]) {
        layer.setAppearance({
            lighting,
            exaggeration: 2,
            opacity: 0.25,
            slopes: false,
            wireframe: false,
            cutHeightCm: 50,
        });
        const mesh = layer.meshes[0];
        assert.ok(Array.isArray(mesh.material));
        const side = mesh.material[4];
        assert.ok(
            side instanceof THREE.MeshPhongMaterial || side instanceof THREE.MeshBasicMaterial,
        );
        assert.equal(side.map, texture);
        assert.equal(side.color.getHexString(), 'ffffff');
        assert.equal(side.opacity, 0.25);
        assert.equal(side.transparent, true);
        assert.equal(side.clippingPlanes![0], layer.clipPlane);
        assert.equal(side instanceof THREE.MeshPhongMaterial, lighting);
        assert.equal(mesh.material[0].map, texture);
        assert.equal(mesh.material[0].color.getHexString(), 'ffffff');
        assert.equal(mesh.material[0].opacity, 1);
        assert.equal(side.customProgramCacheKey(), 'world-nearby-color-v3');
        assert.equal(mesh.material[0].customProgramCacheKey(), 'world-nearby-color-v3');
        assert.notEqual(mesh.material[1].customProgramCacheKey(), 'world-nearby-color-v3');
        assert.ok(mesh.geometry.groups.some((group) => group.materialIndex === 4));
    }
    await layer.enable(context);
    layer.update(view(), new THREE.Vector3(1, 1, 0.5), 800);
    await until(() => layer.meshes.length === 1);
    const mesh = layer.meshes[0];
    assert.ok(Array.isArray(mesh.material));
    const side = mesh.material[4];
    assert.ok(side instanceof THREE.MeshPhongMaterial || side instanceof THREE.MeshBasicMaterial);
    assert.equal(side.map, null);
    assert.equal(side.color.getHexString(), '394149');
    assert.equal(mesh.material[0].map, null);
    assert.equal(mesh.material[0].color.getHexString(), '394149');
    layer.clear();
});

test('invalid map image dimensions report a failed world layer instead of silently using a bad average', async () => {
    const statuses: WorldModelStatus[] = [];
    const layer = new WorldModelLayer(
        (status) => statuses.push(status),
        async () => Response.json(fixture()),
    );
    const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    texture.image.width = 0;
    await layer.enable({
        url: 'https://assets.test/world.json',
        mapKey: 'Island',
        centerX: 0,
        centerY: 0,
        mapBounds,
        texture,
    });
    assert.equal(statuses.at(-1)?.retry, true);
    assert.match(statuses.at(-1)!.text, /World model failed: Invalid world-model numeric value/);
    assert.equal(layer.meshes.length, 0);
    layer.clear();
});

test('fetch keeps the global receiver required by browser-native Window.fetch', async () => {
    const request: typeof fetch = async function (this: typeof globalThis) {
        assert.equal(this, globalThis);
        return Response.json(fixture());
    };
    const layer = new WorldModelLayer(() => {}, request);
    await layer.enable({
        url: 'https://assets.test/world.json',
        mapKey: 'Island',
        centerX: 0,
        centerY: 0,
        mapBounds,
    });
    assert.equal(layer.active, true);
    layer.clear();
});

test('metadata failure is explicit and can retry without leaking a half-active layer', async () => {
    let fail = true;
    const statuses: WorldModelStatus[] = [];
    const request: typeof fetch = async () =>
        fail ? new Response('unavailable', { status: 503 }) : Response.json(fixture());
    const layer = new WorldModelLayer((status) => statuses.push(status), request);
    await layer.enable({
        url: 'https://assets.test/world.json',
        mapKey: 'Island',
        centerX: 0,
        centerY: 0,
        mapBounds,
    });

    assert.equal(statuses.at(-1)?.retry, true);
    assert.match(statuses.at(-1)!.text, /503/);
    assert.equal(layer.meshes.length, 0);
    fail = false;
    layer.retry();
    await until(() => !!statuses.at(-1)?.manifest);
    assert.equal(statuses.at(-1)?.retry, false);
    layer.clear();
});

test('LOD replacement retains old complete geometry until ready, and frustum eviction leaves no geometry', async () => {
    const m = fixture();
    m.tiles = m.tiles.slice(0, 1);
    m.tiles[0].lods.unshift({ ...m.tiles[0].lods[0], url: 'fine.awm', maxErrorCm: 0 });
    let release: (response: Response) => void = () => assert.fail('replacement not requested');
    let loadingFine = false;
    const request: typeof fetch = async (url) => {
        if (String(url).endsWith('world.json')) return Response.json(m);
        if (String(url).endsWith('fine.awm')) {
            loadingFine = true;
            return new Promise<Response>((resolve) => {
                release = resolve;
            });
        }
        return new Response(binary());
    };
    const layer = new WorldModelLayer(() => {}, request),
        camera = view(),
        target = new THREE.Vector3(1, 1, 0.5);
    await layer.enable({
        url: 'https://assets.test/world.json',
        mapKey: 'Island',
        centerX: 0,
        centerY: 0,
        mapBounds,
    });
    camera.position.y = 500;
    camera.lookAt(target);
    layer.update(camera, target, 800);
    await until(() => layer.meshes.length === 1);
    const old = layer.meshes[0];
    let disposed = false;
    old.geometry.addEventListener('dispose', () => {
        disposed = true;
    });
    camera.position.y = 10;
    camera.lookAt(target);
    layer.update(camera, target, 800);
    assert.equal(loadingFine, true);
    assert.equal(layer.meshes[0], old);
    assert.equal(disposed, false);
    release(new Response(binary()));
    await until(() => layer.meshes[0] !== old);
    assert.equal(disposed, true);
    camera.position.set(10000, 100, 10000);
    camera.lookAt(20000, 100, 20000);
    layer.update(camera, new THREE.Vector3(20000, 100, 20000), 800);
    assert.equal(layer.meshes.length, 0);
    layer.clear();
});

test('tile failure leaves no invented surface and provides explicit retry', async () => {
    const m = fixture();
    m.tiles = m.tiles.slice(0, 1);
    let fail = true;
    const statuses: WorldModelStatus[] = [];
    const request: typeof fetch = async (url) =>
        String(url).endsWith('world.json')
            ? Response.json(m)
            : fail
              ? new Response('unavailable', { status: 503 })
              : new Response(binary());
    const layer = new WorldModelLayer((status) => statuses.push(status), request);
    await layer.enable({
        url: 'https://assets.test/world.json',
        mapKey: 'Island',
        centerX: 0,
        centerY: 0,
        mapBounds,
    });
    layer.update(view(), new THREE.Vector3(1, 1, 0.5), 800);
    await until(() => !!statuses.at(-1)?.retry);
    assert.match(statuses.at(-1)!.text, /503/);
    fail = false;
    layer.retry();
    await until(() => layer.meshes.length === 1);
    assert.equal(statuses.at(-1)?.retry, false);
    layer.clear();
});

test('disabling during a tile download rejects stale data and leaves no geometry', async () => {
    const m = fixture();
    m.tiles = m.tiles.slice(0, 1);
    let release: (response: Response) => void = () => assert.fail('download not started');
    const request: typeof fetch = async (url) =>
        String(url).endsWith('world.json')
            ? Response.json(m)
            : new Promise<Response>((resolve) => {
                  release = resolve;
              });
    const layer = new WorldModelLayer(() => {}, request);
    await layer.enable({
        url: 'https://assets.test/world.json',
        mapKey: 'Island',
        centerX: 0,
        centerY: 0,
        mapBounds,
    });
    layer.update(view(), new THREE.Vector3(1, 1, 0.5), 800);
    layer.clear();
    release(new Response(binary()));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(layer.active, false);
    assert.equal(layer.meshes.length, 0);
});
