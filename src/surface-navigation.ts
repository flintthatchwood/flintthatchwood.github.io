import * as THREE from 'three';
import type { MapCamera } from './camera-view.js';

export const MIN_FOCUS_DISTANCE = 0.5;
export const CAMERA_CLEARANCE = 0.25;
const ZOOM_GAIN = 0.002;
const MIN_DOLLY_METERS_PER_PIXEL = 0.01;

function finite(vector: THREE.Vector3): boolean {
    return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

export function wheelPixels(delta: number, mode: number, viewportHeight: number): number {
    if (
        !Number.isFinite(delta) ||
        !Number.isFinite(viewportHeight) ||
        viewportHeight <= 0 ||
        ![0, 1, 2].includes(mode)
    )
        throw new Error('Invalid surface-navigation wheel input.');
    return delta * (mode === 1 ? 16 : mode === 2 ? viewportHeight : 1);
}

export function pinchPixels(previous: number, current: number): number {
    if (![previous, current].every((n) => Number.isFinite(n) && n > 0))
        throw new Error('Invalid surface-navigation pinch input.');
    return Math.log(previous / current) / ZOOM_GAIN;
}

export function moveCamera(
    camera: MapCamera,
    lookTarget: THREE.Vector3,
    forward: number,
    strafe: number,
    seconds: number,
    focusDistance: number,
    fast = false,
    movementMode: 'world' | 'camera' = 'camera',
): THREE.Vector3 {
    if (
        !finite(camera.position) ||
        !finite(lookTarget) ||
        ![forward, strafe, seconds, focusDistance].every(Number.isFinite) ||
        Math.abs(forward) > 1 ||
        Math.abs(strafe) > 1 ||
        seconds < 0 ||
        focusDistance < 0 ||
        (movementMode !== 'world' && movementMode !== 'camera')
    )
        throw new Error('Invalid camera-movement input.');
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    if (movementMode === 'world') {
        right.y = 0;
        if (right.lengthSq() < 1e-12) throw new Error('Invalid world-pan camera orientation.');
        right.normalize();
    }
    const direction = (movementMode === 'world'
        ? new THREE.Vector3(0, 1, 0).cross(right)
        : camera.getWorldDirection(new THREE.Vector3())).multiplyScalar(forward);
    direction.addScaledVector(right, strafe).normalize();
    const speed = THREE.MathUtils.clamp(focusDistance * 0.4, 2, 2000) * (fast ? 4 : 1);
    const movement = direction.multiplyScalar(speed * Math.min(seconds, 0.05));
    camera.position.add(movement);
    lookTarget.add(movement);
    if (movementMode === 'camera') {
        camera.near = THREE.MathUtils.clamp(focusDistance * 0.01, 0.01, 1);
        camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    return movement;
}

export function lookCamera(
    camera: MapCamera,
    lookTarget: THREE.Vector3,
    dx: number,
    dy: number,
    viewportHeight: number,
    invertVertical: boolean,
): void {
    if (!finite(camera.position) || !finite(lookTarget) ||
        ![dx, dy, viewportHeight].every(Number.isFinite) || viewportHeight <= 0)
        throw new Error('Invalid camera-look input.');
    const distance = Math.max(MIN_FOCUS_DISTANCE, camera.position.distanceTo(lookTarget));
    const yaw = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), -2 * Math.PI * dx / viewportHeight,
    );
    const facing = camera.getWorldDirection(new THREE.Vector3());
    const polar = Math.acos(THREE.MathUtils.clamp(-facing.y, -1, 1));
    const next = THREE.MathUtils.clamp(
        polar + (invertVertical ? 1 : -1) * 2 * Math.PI * dy / viewportHeight,
        0.001, Math.PI - 0.001,
    );
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion.clone().premultiply(yaw));
    const rotation = new THREE.Quaternion().setFromAxisAngle(right, next - polar).multiply(yaw);
    camera.quaternion.premultiply(rotation).normalize();
    lookTarget.copy(camera.position).addScaledVector(camera.getWorldDirection(new THREE.Vector3()), distance);
    camera.updateMatrixWorld();
}

export function terrainCameraTravel(
    from: THREE.Vector3,
    to: THREE.Vector3,
    intersect: (ray: THREE.Raycaster) => number | undefined,
): THREE.Vector3 {
    if (!finite(from) || !finite(to)) throw new Error('Invalid camera-collision input.');
    const movement = to.clone().sub(from), distance = movement.length();
    if (distance === 0) return movement;
    const ray = new THREE.Raycaster(from, movement.clone().divideScalar(distance), 0, distance + CAMERA_CLEARANCE);
    const hit = intersect(ray);
    if (hit === undefined) return movement;
    if (!Number.isFinite(hit) || hit < 0) throw new Error('Invalid camera-collision intersection.');
    return movement.multiplyScalar(Math.min(distance, Math.max(0, hit - CAMERA_CLEARANCE)) / distance);
}

export function orbitSurface(
    camera: MapCamera,
    lookTarget: THREE.Vector3,
    pivot: THREE.Vector3,
    dx: number,
    dy: number,
    viewportHeight: number,
    maximumPolarAngle: number,
): void {
    if (
        !finite(camera.position) ||
        !finite(lookTarget) ||
        !finite(pivot) ||
        ![dx, dy, viewportHeight, maximumPolarAngle].every(Number.isFinite) ||
        viewportHeight <= 0 ||
        maximumPolarAngle <= 0.001 ||
        maximumPolarAngle >= Math.PI
    )
        throw new Error('Invalid surface-navigation orbit input.');
    const yaw = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        (-2 * Math.PI * dx) / viewportHeight,
    );
    const facing = camera.getWorldDirection(new THREE.Vector3());
    const polar = Math.acos(THREE.MathUtils.clamp(-facing.y, -1, 1));
    const nextPolar = THREE.MathUtils.clamp(
        polar - (2 * Math.PI * dy) / viewportHeight,
        0.001,
        maximumPolarAngle,
    );
    const orientation = camera.quaternion.clone().premultiply(yaw);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(orientation);
    const rotation = new THREE.Quaternion()
        .setFromAxisAngle(right, nextPolar - polar)
        .multiply(yaw);
    const origin = pivot.clone();
    // Rotate the view frame too, keeping an off-center pivot at the same screen position.
    camera.position.sub(origin).applyQuaternion(rotation).add(origin);
    lookTarget.sub(origin).applyQuaternion(rotation).add(origin);
    camera.quaternion.premultiply(rotation).normalize();
    camera.updateMatrixWorld();
}

export function dollySurface(
    camera: MapCamera,
    lookTarget: THREE.Vector3,
    surface: THREE.Vector3 | undefined,
    pixels: number,
    maximumDistance = 500000,
): number {
    if (
        !finite(camera.position) ||
        !finite(lookTarget) ||
        (surface && !finite(surface)) ||
        !Number.isFinite(pixels) ||
        !Number.isFinite(maximumDistance) ||
        maximumDistance <= MIN_FOCUS_DISTANCE
    )
        throw new Error('Invalid surface-navigation dolly input.');
    if (camera instanceof THREE.OrthographicCamera) {
        camera.zoom = THREE.MathUtils.clamp(camera.zoom * Math.exp(-THREE.MathUtils.clamp(pixels * ZOOM_GAIN, -20, 20)), 0.01, 100000);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        return camera.position.distanceTo(lookTarget);
    }
    const focus = (surface ?? lookTarget).clone();
    const distance = camera.position.distanceTo(focus);
    if (distance <= 0 && !surface)
        throw new Error('Surface-navigation focus coincides with the camera.');
    const proportionalTravel =
        distance * Math.expm1(THREE.MathUtils.clamp(pixels * ZOOM_GAIN, -20, 20));
    const travel =
        Math.sign(pixels) *
        Math.max(Math.abs(proportionalTravel), Math.abs(pixels) * MIN_DOLLY_METERS_PER_PIXEL);
    const signedDistance = Math.min(distance + travel, maximumDistance);
    const nextDistance = Math.max(signedDistance, MIN_FOCUS_DISTANCE);
    const direction = camera.getWorldDirection(new THREE.Vector3());
    camera.position.addScaledVector(direction, distance - signedDistance);
    lookTarget.copy(focus);
    // Keep the focus ahead after crossing a surface, so OrbitControls cannot turn us around.
    if (signedDistance < MIN_FOCUS_DISTANCE)
        lookTarget.copy(camera.position).addScaledVector(direction, nextDistance);
    camera.near = THREE.MathUtils.clamp(nextDistance * 0.01, 0.01, 1);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    return nextDistance;
}
