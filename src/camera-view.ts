import * as THREE from 'three';

export type MapCamera = THREE.PerspectiveCamera;

export function worldUnitsPerPixel(camera: MapCamera, height: number, distance: number): number {
    return (
        (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.max(0.01, distance)) /
        (camera.zoom * Math.max(1, height))
    );
}

export function resizeMapCamera(camera: MapCamera, aspect: number): void {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
}

export function fitMapCamera(camera: MapCamera, bounds: THREE.Box3, aspect: number): void {
    const center = bounds.getCenter(new THREE.Vector3());
    const inverse = camera.quaternion.clone().invert();
    const corners: THREE.Vector3[] = [];
    for (const x of [bounds.min.x, bounds.max.x])
        for (const y of [bounds.min.y, bounds.max.y])
            for (const z of [bounds.min.z, bounds.max.z])
                corners.push(new THREE.Vector3(x, y, z).sub(center).applyQuaternion(inverse));
    const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const distance = Math.max(
        ...corners.map(
            (p) => p.z + (Math.max(Math.abs(p.y), Math.abs(p.x) / aspect) * 1.02) / tangent,
        ),
    );
    camera.zoom = 1;
    camera.position
        .copy(center)
        .addScaledVector(camera.getWorldDirection(new THREE.Vector3()), -distance);
    resizeMapCamera(camera, aspect);
    camera.updateMatrixWorld();
}
