import * as THREE from 'three';
import type { WorldBounds } from './world-model.js';

const POLICY = 'death-air-planar-original-rim-500cm-v1';

interface AirSeal {
    axis: number;
    faces: { x: number; y: number; z: number }[];
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function decodeAirSeals(value: unknown): { bounds: WorldBounds; seals: AirSeal[] } {
    if (!record(value) || value.version !== 1 || value.policy !== POLICY ||
        value.cellSizeCm !== 100 || value.maximumApertureCm !== 500 ||
        !record(value.bounds) || !Array.isArray(value.closed))
        throw new Error('Invalid diagnostic air-seal metadata.');
    const b = value.bounds;
    for (const axis of ['X', 'Y', 'Z']) {
        const low = b[`min${axis}`], high = b[`max${axis}`];
        if (typeof low !== 'number' || typeof high !== 'number' ||
            !Number.isSafeInteger(low / 100) || !Number.isSafeInteger(high / 100) || low >= high)
            throw new Error('Invalid diagnostic air-seal grid bounds.');
    }
    const bounds: WorldBounds = {
        minX: Number(b.minX), minY: Number(b.minY), minZ: Number(b.minZ),
        maxX: Number(b.maxX), maxY: Number(b.maxY), maxZ: Number(b.maxZ),
    };
    const sizes = [(bounds.maxX - bounds.minX) / 100, (bounds.maxY - bounds.minY) / 100,
        (bounds.maxZ - bounds.minZ) / 100];
    const seals = value.closed.map((seal: unknown): AirSeal => {
        if (!record(seal) || typeof seal.axis !== 'number' || ![0, 1, 2].includes(seal.axis) ||
            !Array.isArray(seal.faces) || seal.faces.length === 0 || seal.faces.length > 25)
            throw new Error('Invalid diagnostic air-seal aperture.');
        const axis = seal.axis;
        const faces = seal.faces.map((face: unknown) => {
            if (!record(face)) throw new Error('Invalid diagnostic air-seal face.');
            const coordinates = [face.x, face.y, face.z];
            if (coordinates.some((c, i) => typeof c !== 'number' || !Number.isSafeInteger(c) ||
                c < (i === axis ? 1 : 0) || c >= sizes[i]))
                throw new Error('Diagnostic air-seal face lies outside the original grid.');
            return { x: Number(face.x), y: Number(face.y), z: Number(face.z) };
        });
        const coordinates = faces.map(f => [f.x, f.y, f.z]);
        if (new Set(faces.map(f => `${f.x},${f.y},${f.z}`)).size !== faces.length ||
            sizes.some((_, i) => {
                const values = coordinates.map(c => c[i]);
                return Math.max(...values) - Math.min(...values) + (i === axis ? 0 : 1) >
                    (i === axis ? 0 : 5);
            }))
            throw new Error('Diagnostic air seal is not a flat aperture fitting a 5 m cube.');
        return { axis, faces };
    });
    return { bounds, seals };
}

export class AirSealLayer {
    readonly group = new THREE.Group();

    set(value: unknown, centerX: number, centerY: number): number {
        const { bounds, seals } = decodeAirSeals(value);
        this.clear();
        const material = new THREE.MeshBasicMaterial({
            color: 0x00ff00, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
            toneMapped: false,
        });
        if (seals.length === 0) material.dispose();
        seals.forEach((seal, index) => {
            const positions: number[] = [];
            const worldPoints: number[][] = [];
            for (const face of seal.faces) {
                const base = [bounds.minX + face.x * 100, bounds.minY + face.y * 100,
                    bounds.minZ + face.z * 100];
                const tangents = [0, 1, 2].filter(axis => axis !== seal.axis);
                const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => {
                    const p = base.slice();
                    p[tangents[0]] += u * 100;
                    p[tangents[1]] += v * 100;
                    worldPoints.push(p);
                    return [(p[0] - centerX) / 100, p[2] / 100, (p[1] - centerY) / 100];
                });
                for (const corner of [0, 1, 2, 0, 2, 3]) positions.push(...corners[corner]);
            }
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            const mesh = new THREE.Mesh(geometry, material);
            mesh.renderOrder = 10000;
            const low = [0, 1, 2].map(axis => Math.min(...worldPoints.map(p => p[axis])));
            const high = [0, 1, 2].map(axis => Math.max(...worldPoints.map(p => p[axis])));
            mesh.userData.airSeal = `Seal ${index + 1}: ${['YZ', 'XZ', 'XY'][seal.axis]}\n` +
                `Size: ${high.map((v, i) => (v - low[i]) / 100).join(' x ')} m\n` +
                `World XYZ (cm): ${low.join(', ')} to ${high.join(', ')}\nDiagnostic only; no terrain or collision.`;
            this.group.add(mesh);
        });
        return seals.length;
    }

    clear(): void {
        const materials = new Set<THREE.Material>();
        for (const child of this.group.children) {
            if (!(child instanceof THREE.Mesh)) continue;
            child.geometry.dispose();
            for (const material of Array.isArray(child.material) ? child.material : [child.material])
                materials.add(material);
        }
        materials.forEach(material => material.dispose());
        this.group.clear();
    }
}
