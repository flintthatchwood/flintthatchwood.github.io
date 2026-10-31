import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { flatMapManifest, flatMapMesh } from '../src/flat-map.js';

const extent = { minX: -10000, minY: -20000, maxX: 30000, maxY: 40000 };

test('flat map is a calibrated textured plane with no sampled terrain or invented elevations', () => {
    const manifest = flatMapManifest('Test_WP', extent);
    assert.equal(manifest.minZ, 0);
    assert.equal(manifest.cubeModel, undefined);
    const texture = new THREE.Texture();
    const mesh = flatMapMesh(extent, manifest, texture);
    assert.equal(mesh.material.map, texture);
    mesh.geometry.computeBoundingBox();
    assert.equal(mesh.geometry.boundingBox!.min.x, -200);
    assert.equal(mesh.geometry.boundingBox!.max.z, 300);
    assert.ok(Math.abs(mesh.geometry.boundingBox!.min.y) < 1e-10);
    assert.equal(mesh.position.x, 0);
    assert.equal(mesh.position.z, 0);
    const padded = { ...manifest, originX: -20000, maxX: 30000, originY: -40000, maxY: 40000 };
    const shifted = flatMapMesh(extent, padded);
    assert.equal(shifted.position.x, 50);
    assert.equal(shifted.position.z, 100);
    mesh.geometry.dispose(); mesh.material.dispose();
    shifted.geometry.dispose(); shifted.material.dispose(); texture.dispose();
});

test('flat fallback rejects invalid map calibration instead of inventing a valid map', () => {
    assert.throws(() => flatMapManifest('Test_WP', { ...extent, minX: NaN }));
    assert.throws(() => flatMapManifest('Test_WP', { ...extent, maxY: extent.minY }));
});
