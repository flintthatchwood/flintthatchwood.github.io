import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { dollySurface, moveCamera, pinchPixels, wheelPixels } from '../src/surface-navigation.js';

test('diagnostic wheel travel approaches from full map and crosses a close focus without changing FOV or zoom', () => {
    const camera = new THREE.PerspectiveCamera(48, 1.5, 0.1, 100000);
    const target = new THREE.Vector3();
    camera.position.set(0, 0, 15000);
    camera.lookAt(target);
    const direction = camera.getWorldDirection(new THREE.Vector3());
    const start = camera.position.clone();
    for (let i = 0; i < 80; i++) {
        dollySurface(camera, target, undefined, wheelPixels(-120, 0, 959));
        camera.lookAt(target);
    }
    assert.ok(camera.position.clone().sub(start).dot(direction) > 15000);
    assert.ok(camera.getWorldDirection(new THREE.Vector3()).distanceTo(direction) < 1e-10);
    assert.equal(camera.fov, 48);
    assert.equal(camera.zoom, 1);
    const closeStart = camera.position.clone();
    for (let i = 0; i < 10; i++) dollySurface(camera, target, undefined, -120);
    assert.ok(camera.position.clone().sub(closeStart).dot(direction) >= 12 - 1e-8);
});

test('diagnostic pinch and flight translate a perspective camera while retaining projection and heading', () => {
    const camera = new THREE.PerspectiveCamera(48, 1.5, 0.1, 100000);
    const target = new THREE.Vector3();
    camera.position.set(0, 0, 200);
    camera.lookAt(target);
    const start = camera.position.clone();
    dollySurface(camera, target, undefined, pinchPixels(100, 200));
    assert.ok(Math.abs(camera.position.distanceTo(start) - 100) < 1e-8);
    const nearTarget = camera.position.clone().add(new THREE.Vector3(0, 0, -0.5));
    const flightStart = camera.position.clone(),
        originalTarget = nearTarget.clone();
    const movement = moveCamera(camera, nearTarget, 1, 1, 0.05, 0.5, true, 'camera', 1);
    assert.ok(movement.length() > 0);
    assert.ok(camera.position.clone().sub(flightStart).distanceTo(movement) < 1e-10);
    assert.ok(nearTarget.clone().sub(originalTarget).distanceTo(movement) < 1e-10);
    assert.equal(camera.fov, 48);
    assert.equal(camera.zoom, 1);
});

test('approximate point-cloud hits are projected onto the viewing ray before dollying', () => {
    const camera = new THREE.PerspectiveCamera(48, 1.5, 0.1, 100000);
    const target = new THREE.Vector3();
    camera.position.set(0, 0, 200);
    camera.lookAt(target);
    const direction = camera.getWorldDirection(new THREE.Vector3());
    const ray = new THREE.Raycaster();
    for (let i = 0; i < 80; i++) {
        ray.setFromCamera(new THREE.Vector2(), camera);
        const approximatePoint = camera.position
            .clone()
            .addScaledVector(direction, 0.01)
            .add(new THREE.Vector3(3, 0, 0));
        const distance = ray.ray
            .closestPointToPoint(approximatePoint, new THREE.Vector3())
            .distanceTo(camera.position);
        dollySurface(camera, target, ray.ray.at(distance, new THREE.Vector3()), -120);
        camera.lookAt(target);
        assert.ok(camera.getWorldDirection(new THREE.Vector3()).distanceTo(direction) < 1e-10);
    }
    assert.equal(camera.fov, 48);
    assert.equal(camera.zoom, 1);
});
