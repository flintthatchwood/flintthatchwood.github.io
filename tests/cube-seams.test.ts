import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { cubeSeamGeometry, extractCubeSurface, planCubeSeams } from '../src/cube-seams.js';
import type { WorldTile } from '../src/world-model.js';
import type { WorldModelManifest } from '../src/world-model.js';
import { ProgressiveWorld } from '../src/progressive-world.js';

function patch(x0: number, x1: number, z0: number, z1: number, intervals = [[-1000, 3]]) {
    const positions: number[] = [], indices: number[] = [];
    const geometry = new THREE.BufferGeometry();
    const quad = (points: number[][], material = 4) => {
        const vertex = positions.length / 3, start = indices.length;
        positions.push(...points.flat());
        indices.push(vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3);
        geometry.addGroup(start, 6, material);
    };
    for (const [low, high] of intervals) {
        quad([[x0, low, z0], [x0, low, z1], [x0, high, z1], [x0, high, z0]]);
        quad([[x1, low, z0], [x1, low, z1], [x1, high, z1], [x1, high, z0]]);
        quad([[x0, low, z0], [x1, low, z0], [x1, high, z0], [x0, high, z0]]);
        quad([[x0, low, z1], [x1, low, z1], [x1, high, z1], [x0, high, z1]]);
    }
    const floor = intervals[0][1];
    quad([[x0, floor, z0], [x0, floor, z1], [x1, floor, z1], [x1, floor, z0]], 1);
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3 * 2), 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const tile: WorldTile = {
        id: `${x0}:${z0}`, bounds: { minX: x0 * 100, maxX: x1 * 100, minY: z0 * 100, maxY: z1 * 100, minZ: -100000, maxZ: 100000 },
        lods: [{ url: 'cube.awm', vertices: positions.length / 3, triangles: indices.length / 3, maxErrorCm: 200, cubeSizeCm: 100 }],
    };
    return { geometry, tile };
}
const bounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
function spatialBox(x: number, y: number, height = 1, solid = true, ignored = false) {
    const geometry = solid ? new THREE.BoxGeometry(1, height, 1).translate(x + .5, y + height / 2, .5)
        : new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([], 3)).setIndex([]);
    const tile: WorldTile = {
        id: `${x}:${y}`, bounds: { minX: x * 100, maxX: (x + 1) * 100, minY: 0, maxY: 100, minZ: y * 100, maxZ: (y + height) * 100 },
        lods: [{ url: 'spatial.awm', vertices: 24, triangles: 12, maxErrorCm: 200, cubeSizeCm: 100 }],
    };
    for (const group of geometry.groups) group.materialIndex = ignored ? 5 : 0;
    const result = extractCubeSurface(geometry, tile, 0, 0, true);
    geometry.dispose();
    return result;
}

test('spatial chunks cancel vertical interfaces and expose horizontal floors only against air', () => {
    assert.ok(planCubeSeams([spatialBox(0, 0), spatialBox(0, 1)])
        .every(p => p.faces.every(f => f.edge.axis !== 1 || f.edge.plane !== 1)));
    const plans = planCubeSeams([spatialBox(0, 0), spatialBox(0, 1, 1, false)]);
    const top = { ...plans[0], faces: plans[0].faces.filter(f => f.edge.axis === 1 && f.edge.side === 1) };
    assert.equal(top.faces.length, 1);
    const geometry = cubeSeamGeometry(top, bounds, 0, 0);
    assert.equal(geometry.getAttribute('normal').getY(0), 1);
    assert.equal(geometry.groups[0].materialIndex, 1);
    geometry.dispose();
});

test('vertically stacked neighbors do not duplicate a shared lateral seam', () => {
    const plans = planCubeSeams([spatialBox(0, 0, 2), spatialBox(1, 0), spatialBox(1, 1)]);
    assert.ok(plans.every(p => p.faces.every(f => f.edge.axis !== 0 || f.edge.plane !== 1)));
});

test('omitted spatial air chunks expose solid faces, while ignored masks suppress artificial walls', () => {
    assert.equal(planCubeSeams([spatialBox(0, 0)])[0].faces.length, 6);
    const plans = planCubeSeams([spatialBox(0, 0), spatialBox(1, 0, 1, true, true)]);
    assert.equal(plans[0].faces.length, 5);
    assert.equal(plans[1].faces.length, 0);
    const partial = planCubeSeams([spatialBox(0, 0), spatialBox(1, 0, .5, true, true)]);
    assert.deepEqual(partial[0].faces.filter(f => f.edge.axis === 0 && f.edge.side === 1).map(f => f.rectangle),
        [{ start: 0, end: 1, low: .5, high: 1 }]);
});
function surface(p: ReturnType<typeof patch>) {
    return extractCubeSurface(p.geometry, p.tile, 0, 0);
}

test('equal neighboring solid columns cancel all buried walls; map edges never acquire curtains', () => {
    const a = patch(0, 1, 0, 1), b = patch(1, 2, 0, 1);
    const plans = planCubeSeams([surface(a), surface(b)]);
    assert.ok(plans.every(plan => plan.faces.length === 0));
    for (const p of [a, b]) {
        assert.equal(p.geometry.index!.count, 6);
        assert.deepEqual(p.geometry.groups, [{ start: 0, count: 6, materialIndex: 1 }]);
        p.geometry.dispose();
    }
});

test('mixed heights produce only the exposed step, with correct winding, UVs and picking', () => {
    const a = patch(0, 1, 0, 1), b = patch(1, 2, 0, 1, [[-1000, 5]]);
    const plans = planCubeSeams([surface(a), surface(b)]);
    assert.equal(plans[0].faces.length, 0);
    assert.deepEqual(plans[1].faces.map(face => face.rectangle), [{ start: 0, end: 1, low: 3, high: 5 }]);
    const geometry = cubeSeamGeometry(plans[1], bounds, 0, 0);
    assert.deepEqual(geometry.boundingBox!.min.toArray(), [1, 3, 0]);
    assert.deepEqual(geometry.boundingBox!.max.toArray(), [1, 5, 1]);
    assert.equal(geometry.getAttribute('normal').getX(0), -1);
    assert.deepEqual(geometry.groups, [{ start: 0, count: 6, materialIndex: 4 }]);
    const uv = geometry.getAttribute('uv');
    assert.equal(uv.getX(0), 0.5);
    assert.equal(uv.getX(3), 0.5);
    assert.equal(uv.getY(0), uv.getY(3));
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.updateMatrixWorld();
    assert.ok(new THREE.Raycaster(new THREE.Vector3(0, 4, .5), new THREE.Vector3(1, 0, 0)).intersectObject(mesh).length);
    assert.equal(new THREE.Raycaster(new THREE.Vector3(0, -500, .5), new THREE.Vector3(1, 0, 0)).intersectObject(mesh).length, 0);
    geometry.dispose(); material.dispose(); a.geometry.dispose(); b.geometry.dispose();
});

test('one coarse edge stitches multiple finer neighbors without duplicating overlap or extending below ground', () => {
    const patches = [patch(0, 1, 0, 1, [[-1000, 5]]), patch(1, 2, 0, .5), patch(1, 2, .5, 1, [[-1000, 4]])];
    const plans = planCubeSeams(patches.map(surface));
    assert.deepEqual(plans[0].faces.map(face => face.rectangle), [
        { start: 0, end: .5, low: 3, high: 5 },
        { start: .5, end: 1, low: 4, high: 5 },
    ]);
    assert.ok(plans.flatMap(plan => plan.faces).every(face => face.rectangle.low >= 3));
    for (const p of patches) p.geometry.dispose();
});

test('cave and floating-layer intervals retain only exposed bands, not an XY heightfield', () => {
    const a = patch(0, 1, 0, 1, [[-1000, 3], [6, 8]]), b = patch(1, 2, 0, 1, [[-1000, 3], [7, 9]]);
    const plans = planCubeSeams([surface(a), surface(b)]);
    assert.deepEqual(plans.map(plan => plan.faces.map(face => [face.rectangle.low, face.rectangle.high])), [[[6, 7]], [[8, 9]]]);
    a.geometry.dispose(); b.geometry.dispose();
});

test('partial coverage clips seams to actual neighbors instead of closing uncovered map edges', () => {
    const a = patch(0, 1, 0, 1, [[-1000, 5]]), b = patch(1, 2, .25, .75);
    const plans = planCubeSeams([surface(a), surface(b)]);
    assert.deepEqual(plans[0].faces.map(face => face.rectangle), [{ start: .25, end: .75, low: 3, high: 5 }]);
    assert.equal(planCubeSeams([plans[0].surface])[0].faces.length, 0);
    a.geometry.dispose(); b.geometry.dispose();
});

test('genuine interior cliffs and material groups survive partition-wall extraction', () => {
    const p = patch(0, 1, 0, 1);
    const position = p.geometry.getAttribute('position');
    for (let i = 0; i < 4; i++) position.setX(i, .5);
    surface(p);
    assert.equal(p.geometry.index!.count, 12);
    assert.equal(p.geometry.groups[0].materialIndex, 4);
    assert.equal(p.geometry.groups[1].materialIndex, 1);
    p.geometry.dispose();
});

test('malformed partition caps fail explicitly instead of inventing rectangular occupancy', () => {
    for (const triangle of [[0, 1, 2], [0, 1, 3]]) {
        const p = patch(0, 1, 0, 1);
        for (let i = 0; i < 3; i++) p.geometry.index!.setX(i + 3, triangle[i]);
        assert.throws(() => surface(p), /overlapping or duplicate/);
        p.geometry.dispose();
    }
    const p = patch(0, 1, 0, 1);
    p.geometry.groups[0].count = 3;
    assert.throws(() => surface(p), /incomplete rectangular/);
    p.geometry.dispose();
});

test('a real eighty-metre cliff on a partition boundary is not mistaken for LOD quantization error', () => {
    const a = patch(0, 1, 0, 1, [[-1000, 100]]), b = patch(1, 2, 0, 1, [[-1000, 20]]);
    const plans = planCubeSeams([surface(a), surface(b)]);
    assert.deepEqual(plans[0].faces.map(face => [face.rectangle.low, face.rectangle.high]), [[20, 100]]);
    assert.equal(plans[1].faces.length, 0);
    a.geometry.dispose(); b.geometry.dispose();
});

test('seam normals face outwards on all four partition sides and decoded byte totals are exact', () => {
    for (const [x0, x1, z0, z1, normal] of [
        [1, 2, 0, 1, [-1, 0, 0]],
        [-1, 0, 0, 1, [1, 0, 0]],
        [0, 1, 1, 2, [0, 0, -1]],
        [0, 1, -1, 0, [0, 0, 1]],
    ] as const) {
        const a = patch(0, 1, 0, 1), b = patch(x0, x1, z0, z1, [[-1000, 5]]);
        const plans = planCubeSeams([surface(a), surface(b)]);
        const geometry = cubeSeamGeometry(plans[1], bounds, 0, 0);
        const normals = geometry.getAttribute('normal');
        assert.ok(new THREE.Vector3(normals.getX(0), normals.getY(0), normals.getZ(0)).distanceTo(new THREE.Vector3(...normal)) < 1e-8);
        const bytes = Object.values(geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, geometry.index!.array.byteLength);
        assert.equal(bytes, plans[1].faces.length * (4 * 32 + 6 * 4));
        geometry.dispose(); a.geometry.dispose(); b.geometry.dispose();
    }
});

test('refinement and coarsening replace neighbor seams atomically and expose them to collision picking', async () => {
    const source = [patch(0, 2, 0, 1, [[-1000, 4]]), patch(0, 1, 0, 1), patch(1, 2, 0, 1, [[-1000, 5]]), patch(2, 3, 0, 1, [[-1000, 6]])];
    const binaries = new Map<string, ArrayBuffer>();
    for (const [i, p] of source.entries()) {
        p.tile.id = ['root', 'a', 'b', 'c'][i];
        p.tile.children = i === 0 ? ['a', 'b'] : [];
        p.tile.lods[0].cubeSizeCm = i === 0 || i === 3 ? 200 : 100;
        p.tile.lods[0].url = p.tile.id + '.awm';
        const position = p.geometry.getAttribute('position'), index = p.geometry.index!;
        const buffer = new ArrayBuffer(16 + position.count * 12 + index.count / 3 * 13);
        const view = new DataView(buffer);
        [0x314d5741, position.count, index.count / 3, 0].forEach((value, j) => view.setUint32(j * 4, value, true));
        for (let j = 0; j < position.count; j++) {
            view.setFloat32(16 + j * 12, position.getX(j) * 100, true);
            view.setFloat32(20 + j * 12, position.getZ(j) * 100, true);
            view.setFloat32(24 + j * 12, position.getY(j) * 100, true);
        }
        for (let j = 0; j < index.count; j += 3)
            [index.getX(j), index.getX(j + 2), index.getX(j + 1)].forEach((vertex, k) =>
                view.setUint32(16 + position.count * 12 + (j + k) * 4, vertex, true));
        for (const group of p.geometry.groups)
            for (let j = group.start / 3; j < (group.start + group.count) / 3; j++)
                view.setUint8(16 + position.count * 12 + index.count * 4 + j, group.materialIndex === 4 ? 0 : 1);
        binaries.set(p.tile.lods[0].url, buffer);
        p.geometry.dispose();
    }
    const manifest: WorldModelManifest = {
        version: 1, mapKey: 'Island', meshFormat: 'awm1', heightUnits: 'centimeters',
        cellSizeCm: 100, tileSizeCm: 100, maxErrorCm: 200, bounds: { ...source[0].tile.bounds, maxX: 300 },
        warnings: [], statistics: { representation: 'blocks', hierarchyVersion: 3, seamPolicy: 'closed-voxel-partitions-v1' },
        roots: ['root', 'c'], tiles: source.map(p => p.tile),
    };
    let release: () => void = () => { throw new Error('Pending child was not initialized.'); };
    const pending = new Promise<void>(resolve => { release = resolve; });
    const request: typeof fetch = async url => {
        const name = new URL(String(url)).pathname.slice(1);
        if (name === 'b.awm') await pending;
        return new Response(binaries.get(name));
    };
    const group = new THREE.Group(), material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const world = new ProgressiveWorld(manifest, {
        url: 'https://test.invalid/cubes.json', centerX: 0, centerY: 0, mapBounds: { ...bounds, maxX: 300 },
    }, request, group, geometry => new THREE.Mesh(geometry, Array.from({ length: 5 }, () => material)), { value: 1 }, () => undefined);
    const until = async (predicate: () => boolean) => {
        for (let i = 0; i < 100 && !predicate(); i++) await new Promise<void>(resolve => setImmediate(resolve));
        assert.ok(predicate(), 'Cube seam transaction did not settle.');
    };
    world.start();
    await until(() => world.meshes.length === 3);
    const root = world.meshes[0];
    const neighborSeam = world.meshes.find(mesh => mesh.geometry.boundingBox?.min.y === 4)!;
    let neighborDisposed = 0;
    neighborSeam.geometry.addEventListener('dispose', () => neighborDisposed++);
    const camera = new THREE.PerspectiveCamera(42, 1, .1, 1000000);
    camera.position.set(.5, 10, .5);
    camera.lookAt(.5, 0, .5);
    world.update(camera, 800, 1);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(world.meshes.includes(root));
    assert.ok(world.meshes.includes(neighborSeam));
    release();
    await until(() => world.meshes.length === 5);
    assert.ok(!world.meshes.includes(root));
    assert.equal(neighborDisposed, 1);
    assert.ok(world.meshes.some(mesh => mesh.geometry.boundingBox?.min.y === 5 && mesh.geometry.boundingBox.max.y === 6));
    const seam = world.meshes.find(mesh => mesh.geometry.boundingBox?.min.y === 3)!;
    assert.ok(seam, 'Exposed neighbor step is part of the picking surface.');
    group.updateMatrixWorld(true);
    assert.ok(new THREE.Raycaster(new THREE.Vector3(0, 4, .5), new THREE.Vector3(1, 0, 0)).intersectObjects(world.meshes, false).length);
    assert.equal(new THREE.Raycaster(new THREE.Vector3(0, -500, .5), new THREE.Vector3(1, 0, 0)).intersectObjects(world.meshes, false).length, 0);
    let disposed = 0;
    seam.geometry.addEventListener('dispose', () => disposed++);
    camera.position.y = 10000;
    camera.lookAt(.5, 0, .5);
    world.update(camera, 800, 1);
    await until(() => world.meshes.length === 3);
    assert.equal(disposed, 1);
    assert.equal(group.children.length, 3);
    world.clear();
    assert.equal(group.children.length, 0);
    material.dispose();
});
