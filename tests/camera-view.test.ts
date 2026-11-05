import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
    fitMapCamera,
    resizeMapCamera,
    worldUnitsPerPixel,
    type MapCamera,
} from '../src/camera-view.js';
import { displayNumber } from '../src/display-number.js';

test('perspective map fit contains all corners and fills a viewport axis', () => {
    const bounds = new THREE.Box3(
        new THREE.Vector3(-3429, -2000, -3429),
        new THREE.Vector3(3431, 547, 3431),
    );
    const target = bounds.getCenter(new THREE.Vector3());
    for (const aspect of [0.55, 1, 2.3]) {
        const camera: MapCamera = new THREE.PerspectiveCamera(42, aspect, 1, 1000000);
        camera.position.copy(target).add(new THREE.Vector3(0, 15000, 0.01));
        camera.lookAt(target);
        fitMapCamera(camera, bounds, aspect);
        const extents: number[] = [];
        for (const x of [bounds.min.x, bounds.max.x])
            for (const y of [bounds.min.y, bounds.max.y])
                for (const z of [bounds.min.z, bounds.max.z]) {
                    const p = new THREE.Vector3(x, y, z).project(camera);
                    assert.ok(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && Math.abs(p.z) <= 1);
                    extents.push(Math.abs(p.x), Math.abs(p.y));
                }
        assert.ok(Math.max(...extents) > 0.97);
        const north = target
            .clone()
            .add(new THREE.Vector3(0, 0, -100))
            .project(camera);
        assert.ok(north.y > 0 && Math.abs(north.x) < 1e-8);
    }
});

test('perspective resize updates aspect without moving or turning the camera', () => {
    const camera = new THREE.PerspectiveCamera(42, 1.8, 1, 1000000);
    const target = new THREE.Vector3(20, 40, -30);
    camera.position.set(100, 200, 300);
    camera.lookAt(target);
    const position = camera.position.clone();
    const rotation = camera.quaternion.clone();
    const scale = worldUnitsPerPixel(camera, 800, camera.position.distanceTo(target));
    resizeMapCamera(camera, 0.55);
    assert.equal(camera.aspect, 0.55);
    assert.deepEqual(camera.position, position);
    assert.ok(camera.quaternion.equals(rotation));
    assert.equal(worldUnitsPerPixel(camera, 800, camera.position.distanceTo(target)), scale);
});

test('close perspective picking retains sub-metre focus scale', () => {
    const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000000);
    const target = new THREE.Vector3();
    camera.position.set(0, 0, 0.5);
    camera.lookAt(target);
    const scale = worldUnitsPerPixel(camera, 800, 0.5);
    assert.ok(Math.abs(worldUnitsPerPixel(camera, 800, 1) - scale * 2) < 1e-10);
});

test('display numbers have exactly two decimals without negative zero', () => {
    assert.equal(displayNumber(-173514.22727272726), '-173514.23');
    assert.equal(displayNumber(-3426.3181818182), '-3426.32');
    assert.equal(displayNumber(10), '10.00');
    assert.equal(displayNumber(-0.00001), '0.00');
});
