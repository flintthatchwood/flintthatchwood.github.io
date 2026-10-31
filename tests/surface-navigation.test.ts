import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
    dollySurface,
    moveCamera,
    lookCamera,
    terrainCameraTravel,
    CAMERA_CLEARANCE,
    orbitSurface,
    pinchPixels,
    MIN_FOCUS_DISTANCE,
    wheelPixels,
} from '../src/surface-navigation.js';
import { cameraCodeDirection, decodeCameraCode, encodeCameraCode } from '../src/camera-code.js';

function fixture(distance = 10) {
    const camera = new THREE.PerspectiveCamera(42, 1.5, 1, 1000000);
    const target = new THREE.Vector3(1200, 40, -2300);
    camera.position.copy(target).add(new THREE.Vector3(0, 0.6, 0.8).multiplyScalar(distance));
    camera.lookAt(target);
    camera.updateMatrixWorld();
    return { camera, target };
}

function close(actual: number, expected: number, tolerance = 1e-8) {
    assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
}

test('camera mouse look rotates in place; dragging left looks left and dragging up looks up', () => {
    for (const orthographic of [false, true]) {
        const camera = orthographic
            ? new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 100000)
            : new THREE.PerspectiveCamera(42, 1, 0.1, 100000);
        camera.position.set(10, 20, 30);
        const target = camera.position.clone().addScaledVector(
            cameraCodeDirection({ position: [0, 0, 0], pitch: 0, yaw: 45 }), 100,
        );
        camera.lookAt(target);
        const position = camera.position.clone();
        lookCamera(camera, target, -20, -20, 800, false);
        const code = decodeCameraCode(encodeCameraCode([0, 0, 0], camera.getWorldDirection(new THREE.Vector3())));
        assert.ok(code.yaw < 45 && code.pitch > 0);
        assert.deepEqual(camera.position, position);
        close(camera.position.distanceTo(target), 100);
        lookCamera(camera, target, 0, 20, 800, true);
        const inverted = decodeCameraCode(encodeCameraCode([0, 0, 0], camera.getWorldDirection(new THREE.Vector3())));
        assert.ok(inverted.pitch > code.pitch);
        assert.deepEqual(camera.position, position);
        lookCamera(camera, target, 0, 1e6, 800, true);
        assert.ok(camera.getWorldDirection(new THREE.Vector3()).y < 1);
        assert.deepEqual(camera.position, position);
    }
});

test('swept camera travel blocks thin floors and ceilings from both sides without tunnelling', () => {
    const geometry = new THREE.PlaneGeometry(100, 100);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const floor = new THREE.Mesh(geometry, material);
    floor.updateMatrixWorld();
    const intersect = (ray: THREE.Raycaster) => ray.intersectObject(floor)[0]?.distance;
    for (const sign of [-1, 1]) {
        const from = new THREE.Vector3(0, sign * 10, 0), to = new THREE.Vector3(0, -sign * 10000, 0);
        const movement = terrainCameraTravel(from, to, intersect);
        close(from.clone().add(movement).y, sign * CAMERA_CLEARANCE);
        assert.deepEqual(from, new THREE.Vector3(0, sign * 10, 0));
        const away = from.clone().add(new THREE.Vector3(0, sign * 100, 0));
        assert.deepEqual(terrainCameraTravel(from, away, intersect), away.sub(from));
    }
    const tangent = new THREE.Vector3(10, CAMERA_CLEARANCE, 0);
    assert.deepEqual(terrainCameraTravel(tangent, tangent.clone().add(new THREE.Vector3(10, 0, 0)), intersect), new THREE.Vector3(10, 0, 0));
    assert.deepEqual(terrainCameraTravel(tangent, tangent, intersect), new THREE.Vector3());
    geometry.dispose();
    material.dispose();
});

test('camera collision blocks walls and permits retreat without changing orientation or target distance', () => {
    const geometry = new THREE.PlaneGeometry(100, 100);
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const wall = new THREE.Mesh(geometry, material);
    wall.updateMatrixWorld();
    const from = new THREE.Vector3(2, 3, 10), to = new THREE.Vector3(2, 3, -20);
    const travel = terrainCameraTravel(from, to, ray => ray.intersectObject(wall)[0]?.distance);
    close(from.clone().add(travel).z, CAMERA_CLEARANCE);
    assert.deepEqual(terrainCameraTravel(from, to, () => undefined), to.clone().sub(from));
    assert.throws(() => terrainCameraTravel(from, to, () => NaN), /intersection/);
    assert.throws(() => lookCamera(new THREE.PerspectiveCamera(), new THREE.Vector3(), 0, 0, 0, false), /look input/);
    geometry.dispose();
    material.dispose();
});

test('WASD flight uses view-forward and camera-right in both projections without changing heading', () => {
    for (const orthographic of [false, true])
        for (const [forward, strafe] of [[1, 0], [-1, 0], [0, -1], [0, 1], [1, 1]]) {
            const view = fixture(100);
            const camera = orthographic
                ? new THREE.OrthographicCamera(-100, 100, 100, -100, 1, 1000000)
                : view.camera;
            camera.position.copy(view.camera.position);
            camera.quaternion.copy(view.camera.quaternion);
            const position = camera.position.clone(), target = view.target.clone();
            const quaternion = camera.quaternion.clone(), zoom = camera.zoom;
            const facing = camera.getWorldDirection(new THREE.Vector3());
            const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
            const expected = facing.multiplyScalar(forward).addScaledVector(right, strafe).normalize().multiplyScalar(2);
            const movement = moveCamera(camera, view.target, forward, strafe, 0.05, 100);
            assert.ok(movement.distanceTo(expected) < 1e-8);
            assert.ok(camera.position.clone().sub(position).distanceTo(movement) < 1e-8);
            assert.ok(view.target.clone().sub(target).distanceTo(movement) < 1e-8);
            close(Math.abs(camera.quaternion.dot(quaternion)), 1);
            close(camera.position.distanceTo(view.target), 100);
            close(camera.zoom, zoom);
        }
});

test('World WASD pans by yaw only, including exact vertical views, without changing altitude or projection', () => {
    for (const orthographic of [false, true])
        for (const yaw of [-179, -90, 0, 54.83, 90, 125.53, 179])
            for (const pitch of [-90, -75, 0, 45, 90])
                for (const [forward, strafe] of [[1, 0], [-1, 0], [0, 1], [1, 1]]) {
                    const camera = orthographic
                        ? new THREE.OrthographicCamera(-100, 100, 100, -100, 0.37, 100000)
                        : new THREE.PerspectiveCamera(42, 1, 0.37, 100000);
                    camera.position.set(100, 200, 300);
                    camera.zoom = 2.5;
                    const direction = cameraCodeDirection({ position: [0, 0, 0], yaw, pitch: 0 });
                    camera.lookAt(camera.position.clone().add(direction));
                    camera.rotateX(THREE.MathUtils.degToRad(pitch));
                    const target = camera.position.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()), 100);
                    camera.updateProjectionMatrix();
                    const position = camera.position.clone(), originalTarget = target.clone();
                    const quaternion = camera.quaternion.clone(), projection = camera.projectionMatrix.clone();
                    const radians = THREE.MathUtils.degToRad(yaw);
                    const expected = new THREE.Vector3(
                        Math.cos(radians) * forward - Math.sin(radians) * strafe,
                        0,
                        Math.sin(radians) * forward + Math.cos(radians) * strafe,
                    ).normalize().multiplyScalar(2);
                    const movement = moveCamera(camera, target, forward, strafe, 0.05, 100, false, 'world');
                    assert.ok(movement.distanceTo(expected) < 1e-8, `${yaw}, ${pitch}`);
                    assert.equal(camera.position.y, position.y);
                    assert.equal(target.y, originalTarget.y);
                    assert.ok(target.clone().sub(originalTarget).distanceTo(movement) < 1e-8);
                    assert.ok(camera.quaternion.equals(quaternion));
                    assert.ok(camera.projectionMatrix.equals(projection));
                    assert.equal(camera.zoom, 2.5);
                    assert.equal(camera.near, 0.37);
                }
});

test('keyboard flight is frame-rate independent, normalized diagonally and four times faster with Shift', () => {
    for (const fast of [false, true]) {
        const distances = [0.02, 0.04].map(seconds => {
            const { camera, target } = fixture(100), start = camera.position.clone();
            for (let step = 0; step < Math.round(1 / seconds); step++)
                moveCamera(camera, target, 1, 1, seconds, 100, fast);
            return camera.position.distanceTo(start);
        });
        close(distances[0], fast ? 160 : 40);
        close(distances[1], distances[0]);
    }
});

test('keyboard flight has a minimum speed, caps stalled frames and cancels opposing keys', () => {
    const { camera, target } = fixture(), start = camera.position.clone();
    close(moveCamera(camera, target, 1, 0, 1000, 0.01).length(), 0.1);
    close(camera.position.distanceTo(start), 0.1);
    close(moveCamera(camera, target, 0, 0, 0.05, 100).length(), 0);
    for (const [forward, strafe, seconds, distance] of [[NaN, 0, 1, 1], [2, 0, 1, 1], [0, 2, 1, 1], [1, 0, -1, 1], [1, 0, 1, -1]])
        assert.throws(() => moveCamera(camera, target, forward, strafe, seconds, distance), /movement input/);
});

test('off-center surface pivot stays under the pressed pixel without an initial snap', () => {
    const { camera, target } = fixture(100);
    const pivot = target.clone().add(new THREE.Vector3(15, 0, -12));
    const screen = pivot.clone().project(camera),
        radius = camera.position.distanceTo(pivot);
    const lookDistance = camera.position.distanceTo(target);
    orbitSurface(camera, target, pivot, 65, 35, 800, Math.PI * 0.98);
    const after = pivot.clone().project(camera);
    close(screen.x, after.x);
    close(screen.y, after.y);
    close(camera.position.distanceTo(pivot), radius);
    close(camera.position.distanceTo(target), lookDistance);
    // OrbitControls can still look at its target without undoing the off-center orbit.
    const rotation = camera.quaternion.clone();
    camera.lookAt(target);
    close(Math.abs(rotation.dot(camera.quaternion)), 1);
});

test('orbit travel scales with distance to the pressed surface', () => {
    const travel = [5, 500].map((distance) => {
        const { camera, target } = fixture(distance),
            start = camera.position.clone();
        orbitSurface(camera, target, target.clone(), 200, 0, 800, Math.PI * 0.98);
        return start.distanceTo(camera.position);
    });
    close(travel[1] / travel[0], 100);
    assert.ok(travel[0] > 5 && travel[0] < 10);
});

test('orbit respects the current legacy or cave-view polar limits', () => {
    for (const limit of [Math.PI * 0.495, Math.PI * 0.98]) {
        const { camera, target } = fixture();
        orbitSurface(camera, target, target.clone(), 0, -5000, 800, limit);
        close(Math.acos(-camera.getWorldDirection(new THREE.Vector3()).y), limit);
        orbitSurface(camera, target, target.clone(), 0, 5000, 800, limit);
        close(Math.acos(-camera.getWorldDirection(new THREE.Vector3()).y), 0.001);
    }
});

test('wheel dollies toward the centered landscape, not a stale map-center target', () => {
    const { camera, target } = fixture(10),
        surface = target.clone();
    target.addScaledVector(camera.getWorldDirection(new THREE.Vector3()), -9);
    const position = camera.position.clone(),
        orientation = camera.quaternion.clone(),
        fov = camera.fov;
    const distance = dollySurface(camera, target, surface, -100);
    close(distance, 10 * Math.exp(-0.2));
    close(position.distanceTo(camera.position), 10 - distance);
    close(camera.position.distanceTo(surface), distance);
    close(surface.clone().project(camera).x, 0);
    close(surface.clone().project(camera).y, 0);
    close(Math.abs(orientation.dot(camera.quaternion)), 1);
    assert.equal(camera.fov, fov);
    assert.equal(camera.zoom, 1);
    assert.ok(target.equals(surface));
});

test('wheel steps retain proportional movement above the minimum travel rate', () => {
    for (const original of [10, 50, 500, 5000]) {
        const { camera, target } = fixture(original);
        const next = dollySurface(camera, target, target.clone(), -100);
        close(next / original, Math.exp(-0.2));
        close(camera.position.distanceTo(target), next);
    }
});

test('a wheel revolution can cross a nearby surface and two can pull back hundreds of meters', () => {
    const inward = fixture(5);
    const start = inward.camera.position.clone();
    const direction = inward.camera.getWorldDirection(new THREE.Vector3());
    dollySurface(inward.camera, inward.target, inward.target.clone(), -1200);
    close(inward.camera.position.clone().sub(start).dot(direction), 12);
    const outward = fixture(5),
        surface = outward.target.clone();
    dollySurface(outward.camera, outward.target, surface, 1200);
    const farDistance = dollySurface(outward.camera, outward.target, surface, 1200);
    assert.ok(farDistance > 600);
});

test('dolly preserves maximum range', () => {
    const { camera, target } = fixture(10),
        surface = target.clone();
    close(dollySurface(camera, target, surface, 1e6, 5000), 5000);
    close(camera.position.distanceTo(surface), 5000);
});

test('camera on a surface can move in either direction without turning around', () => {
    for (const pixels of [-100, 100]) {
        const { camera, target } = fixture();
        const start = camera.position.clone();
        const direction = camera.getWorldDirection(new THREE.Vector3());
        const orientation = camera.quaternion.clone();
        const next = dollySurface(camera, target, camera.position, pixels);
        close(camera.position.clone().sub(start).dot(direction), -pixels * 0.01);
        close(camera.position.distanceTo(target), next);
        assert.ok(next >= MIN_FOCUS_DISTANCE);
        close(Math.abs(orientation.dot(camera.quaternion)), 1);
        camera.lookAt(target);
        close(Math.abs(orientation.dot(camera.quaternion)), 1);
        assert.ok(camera.near < MIN_FOCUS_DISTANCE);
    }
});

test('minimum travel remains 1 m per 100 wheel pixels even with repeated nearby wall hits', () => {
    for (const pixels of [-100, 100]) {
        const { camera, target } = fixture();
        const direction = camera.getWorldDirection(new THREE.Vector3());
        const orientation = camera.quaternion.clone();
        for (let step = 0; step < 20; step++) {
            const start = camera.position.clone();
            const surface = start.clone().addScaledVector(direction, 0.01);
            dollySurface(camera, target, surface, pixels);
            close(camera.position.clone().sub(start).dot(direction), -pixels * 0.01);
            assert.ok(
                target.clone().sub(camera.position).dot(direction) >= MIN_FOCUS_DISTANCE - 1e-8,
            );
            camera.lookAt(target);
            close(Math.abs(orientation.dot(camera.quaternion)), 1);
        }
    }
});

test('minimum travel scales with fractional wheel input and zero input does not move', () => {
    for (const pixels of [-0.25, 0, 0.25]) {
        const { camera, target } = fixture(0.01);
        const start = camera.position.clone();
        const direction = camera.getWorldDirection(new THREE.Vector3());
        dollySurface(camera, target, target.clone(), pixels);
        close(camera.position.clone().sub(start).dot(direction), -pixels * 0.01);
    }
});

test('orbit accepts the look target itself as the pivot without mutating its position', () => {
    const { camera, target } = fixture(),
        original = target.clone();
    orbitSurface(camera, target, target, 100, 20, 800, Math.PI * 0.98);
    assert.ok(target.distanceTo(original) < 1e-8);
    close(camera.position.distanceTo(target), 10);
});

test('empty center uses the existing look focus rather than resetting to the model center', () => {
    const { camera, target } = fixture(200),
        focus = target.clone();
    const next = dollySurface(camera, target, undefined, -100);
    close(next, 200 * Math.exp(-0.2));
    assert.ok(target.equals(focus));
});

test('pixel, line and page wheel units normalize consistently', () => {
    close(wheelPixels(100, 0, 800), 100);
    close(wheelPixels(6.25, 1, 800), 100);
    close(wheelPixels(0.125, 2, 800), 100);
});

test('pinch spread uses the same surface-relative dolly and halves the distance', () => {
    const { camera, target } = fixture(20);
    close(dollySurface(camera, target, target.clone(), pinchPixels(100, 200)), 10);
    close(dollySurface(camera, target, target.clone(), pinchPixels(200, 100)), 20);
});

test('invalid navigation inputs fail explicitly', () => {
    const { camera, target } = fixture();
    assert.throws(() => wheelPixels(NaN, 0, 800), /wheel input/);
    assert.throws(() => wheelPixels(100, 3, 800), /wheel input/);
    assert.throws(() => wheelPixels(100, 0, 0), /wheel input/);
    assert.throws(() => pinchPixels(0, 100), /pinch input/);
    assert.throws(() => dollySurface(camera, target, undefined, Infinity), /dolly input/);
    assert.throws(
        () => orbitSurface(camera, target, target.clone(), 1, 1, 0, Math.PI * 0.98),
        /orbit input/,
    );
});
