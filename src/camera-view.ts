import * as THREE from 'three';

export type MapCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
export type Projection = 'perspective' | 'orthographic';

export function worldUnitsPerPixel(camera: MapCamera, height: number, distance: number): number {
    return camera instanceof THREE.OrthographicCamera
        ? (camera.top - camera.bottom) / (camera.zoom * Math.max(1, height))
        : (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.max(0.01, distance)) /
              (camera.zoom * Math.max(1, height));
}

export function resizeMapCamera(camera: MapCamera, aspect: number): void {
    if (camera instanceof THREE.PerspectiveCamera) camera.aspect = aspect;
    else {
        const half = (camera.top - camera.bottom) / 2;
        camera.left = -half * aspect;
        camera.right = half * aspect;
    }
    camera.updateProjectionMatrix();
}

export function changeProjection(
    current: MapCamera,
    target: THREE.Vector3,
    projection: Projection,
    aspect: number,
): MapCamera {
    const distance = Math.max(0.5, current.position.distanceTo(target));
    const span = worldUnitsPerPixel(current, 1, distance);
    const camera: MapCamera =
        projection === 'orthographic'
            ? new THREE.OrthographicCamera(
                  (-span * aspect) / 2,
                  (span * aspect) / 2,
                  span / 2,
                  -span / 2,
                  current.near,
                  current.far,
              )
            : new THREE.PerspectiveCamera(42, aspect, current.near, current.far);
    const nextDistance =
        camera instanceof THREE.PerspectiveCamera
            ? span / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))
            : distance;
    camera.position
        .copy(target)
        .addScaledVector(current.getWorldDirection(new THREE.Vector3()), -nextDistance);
    camera.quaternion.copy(current.quaternion);
    camera.up.copy(current.up);
    camera.updateMatrixWorld();
    return camera;
}

export function fitMapCamera(camera: MapCamera, bounds: THREE.Box3, aspect: number): void {
    const center = bounds.getCenter(new THREE.Vector3());
    const inverse = camera.quaternion.clone().invert();
    const corners: THREE.Vector3[] = [];
    for (const x of [bounds.min.x, bounds.max.x])
        for (const y of [bounds.min.y, bounds.max.y])
            for (const z of [bounds.min.z, bounds.max.z])
                corners.push(new THREE.Vector3(x, y, z).sub(center).applyQuaternion(inverse));
    if (camera instanceof THREE.OrthographicCamera) {
        const half =
            Math.max(...corners.map((p) => Math.max(Math.abs(p.y), Math.abs(p.x) / aspect))) * 1.02;
        camera.top = half;
        camera.bottom = -half;
        camera.zoom = 1;
    } else {
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
    }
    resizeMapCamera(camera, aspect);
    camera.updateMatrixWorld();
}
