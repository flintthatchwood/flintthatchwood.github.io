import * as THREE from 'three';
import type { CoordinateSystem } from './data/types.js';
import { validateManifest, type TerrainManifest } from './terrain.js';

type MapExtent = Pick<CoordinateSystem, 'minX' | 'minY' | 'maxX' | 'maxY'>;

export function flatMapManifest(mapKey: string, extent: MapExtent): TerrainManifest {
    const manifest: TerrainManifest = {
        version: 2, mapKey, heightUnits: 'centimeters',
        originX: extent.minX, originY: extent.minY, maxX: extent.maxX, maxY: extent.maxY,
        minZ: 0, maxZ: 1, warnings: [],
    };
    validateManifest(manifest, mapKey);
    return manifest;
}

export function flatMapMesh(
    extent: MapExtent,
    manifest: TerrainManifest,
    texture?: THREE.Texture,
): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
    flatMapManifest(manifest.mapKey, extent);
    const geometry = new THREE.PlaneGeometry((extent.maxX - extent.minX) / 100, (extent.maxY - extent.minY) / 100);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        map: texture, color: texture ? 0xffffff : 0x526777, side: THREE.DoubleSide,
    }));
    mesh.position.set(
        (extent.minX + extent.maxX - manifest.originX - manifest.maxX) / 200,
        0,
        (extent.minY + extent.maxY - manifest.originY - manifest.maxY) / 200,
    );
    return mesh;
}
