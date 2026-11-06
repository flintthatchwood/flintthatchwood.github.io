import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AirSealLayer, decodeAirSeals } from '../src/air-seals.js';

function fixture(axis = 2) {
    return {
        version: 1, policy: 'death-air-planar-original-rim-500cm-v1',
        cellSizeCm: 100, maximumApertureCm: 500,
        bounds: { minX: -12800, minY: 0, minZ: -12800, maxX: 12800, maxY: 12800, maxZ: 12800 },
        closed: [{ axis, faces: [{ x: 127, y: 7, z: 128 }] }],
    };
}

test('diagnostic seals align with signed source origins and all three planes', () => {
    const layer = new AirSealLayer();
    for (const axis of [0, 1, 2]) {
        assert.equal(layer.set(fixture(axis), 0, 0), 1);
        const mesh = layer.group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
        const position = mesh.geometry.getAttribute('position');
        assert.deepEqual([position.getX(0), position.getY(0), position.getZ(0)], [-1, 0, 7]);
        assert.equal(position.count, 6);
        mesh.geometry.computeBoundingBox();
        const size = mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
        assert.equal([size.x, size.z, size.y][axis], 0);
        assert.equal(mesh.material.color.getHex(), 0x00ff00);
        assert.equal(mesh.material.side, THREE.DoubleSide);
        assert.equal(mesh.material.depthTest, false);
        assert.equal(mesh.material.depthWrite, false);
        assert.equal(mesh.material.toneMapped, false);
        assert.equal(mesh.material.clippingPlanes, null);
        assert.match(mesh.userData.airSeal, /Diagnostic only; no terrain or collision/);
    }
    layer.clear();
});

test('seal geometry and materials are disposed on replacement and map clearing', () => {
    const layer = new AirSealLayer();
    layer.set(fixture(), 0, 0);
    const first = layer.group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    let geometries = 0, materials = 0;
    first.geometry.addEventListener('dispose', () => geometries++);
    first.material.addEventListener('dispose', () => materials++);
    layer.set(fixture(1), 0, 0);
    assert.equal(geometries, 1);
    assert.equal(materials, 1);
    layer.clear();
    assert.equal(layer.group.children.length, 0);
    const empty = fixture();
    empty.closed = [];
    assert.equal(layer.set(empty, 0, 0), 0);
});

test('seal diagnostics reject wrong policies, nonplanar, duplicate, wide and out-of-grid faces', () => {
    for (const data of [
        { ...fixture(), policy: 'legacy' },
        { ...fixture(), cellSizeCm: 500 },
        { ...fixture(), bounds: { ...fixture().bounds, minZ: -12799 } },
        { ...fixture(), closed: [{ axis: 3, faces: [{ x: 1, y: 1, z: 1 }] }] },
        { ...fixture(), closed: [{ axis: 2, faces: [] }] },
        { ...fixture(), closed: [{ axis: 2, faces: [{ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 2 }] }] },
        { ...fixture(), closed: [{ axis: 2, faces: [{ x: 1, y: 1, z: 1 }, { x: 6, y: 1, z: 1 }] }] },
        { ...fixture(), closed: [{ axis: 2, faces: [{ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }] }] },
        { ...fixture(), closed: [{ axis: 2, faces: [{ x: 256, y: 1, z: 1 }] }] },
        { ...fixture(), closed: [{ axis: 2, faces: [{ x: 1, y: 1, z: 0 }] }] },
    ]) assert.throws(() => decodeAirSeals(data), /diagnostic|Diagnostic/);
});
