import * as THREE from 'three';
import { boundedResponse } from './bounded-response.js';

export const MAX_PATCHES = 200_000;
export const MAX_TILE_BYTES = 64 * 1024 * 1024;
const COORDINATE_LIMIT = 100_000_000;

interface Bounds {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
}
export interface WalkabilityTile {
    url: string;
    records: number;
    bounds: Bounds;
}
export interface WalkabilityManifest {
    version: 1;
    mapKey: string;
    recordFormat: 'float32-le-xyz-normal';
    recordStride: 24;
    heightUnits: 'centimeters';
    spacing: number;
    walkableFloorZ: number;
    walkableFloorAngle: number;
    candidateOnly: true;
    warnings: string[];
    statistics: object;
    tiles: WalkabilityTile[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const bounded = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= COORDINATE_LIMIT;

export function validateWalkability(value: unknown, mapKey: string): WalkabilityManifest {
    if (
        !isObject(value) ||
        value.version !== 1 ||
        value.mapKey !== mapKey ||
        value.recordFormat !== 'float32-le-xyz-normal' ||
        value.recordStride !== 24 ||
        value.heightUnits !== 'centimeters' ||
        value.spacing !== 500 ||
        value.candidateOnly !== true ||
        typeof value.walkableFloorZ !== 'number' ||
        !Number.isFinite(value.walkableFloorZ) ||
        value.walkableFloorZ < 0 ||
        value.walkableFloorZ > 1 ||
        typeof value.walkableFloorAngle !== 'number' ||
        !Number.isFinite(value.walkableFloorAngle) ||
        value.walkableFloorAngle < 0 ||
        value.walkableFloorAngle > 90 ||
        !Array.isArray(value.warnings) ||
        !value.warnings.every((warning) => typeof warning === 'string') ||
        !isObject(value.statistics) ||
        !Array.isArray(value.tiles) ||
        value.tiles.length > 4096
    )
        throw new Error('Invalid walkability manifest.');
    for (const tile of value.tiles) {
        if (
            !isObject(tile) ||
            typeof tile.url !== 'string' ||
            !tile.url.trim() ||
            !Number.isSafeInteger(tile.records) ||
            (tile.records as number) < 0 ||
            (tile.records as number) * 24 > MAX_TILE_BYTES ||
            !isObject(tile.bounds) ||
            !['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'].every((key) =>
                bounded((tile.bounds as Record<string, unknown>)[key]),
            )
        )
            throw new Error('Invalid walkability tile (64 MiB per-tile limit).');
        const bounds = tile.bounds as unknown as Bounds;
        if (bounds.minX > bounds.maxX || bounds.minY > bounds.maxY || bounds.minZ > bounds.maxZ)
            throw new Error('Invalid walkability tile bounds.');
    }
    return value as unknown as WalkabilityManifest;
}

export function visitWalkability(
    buffer: ArrayBuffer,
    tile: WalkabilityTile,
    visit: (view: DataView, offset: number) => void,
): void {
    if (buffer.byteLength !== tile.records * 24)
        throw new Error('Incorrect walkability binary length.');
    const view = new DataView(buffer);
    const b = tile.bounds;
    const minimum = [b.minX, b.minY, b.minZ];
    const maximum = [b.maxX, b.maxY, b.maxZ];
    for (let offset = 0; offset < buffer.byteLength; offset += 24) {
        for (let axis = 0; axis < 3; axis++) {
            const coordinate = view.getFloat32(offset + axis * 4, true);
            if (
                !bounded(coordinate) ||
                coordinate < minimum[axis] - 0.1 ||
                coordinate > maximum[axis] + 0.1
            )
                throw new Error('Invalid walkability coordinate or tile bounds.');
        }
        const length = Math.hypot(
            view.getFloat32(offset + 12, true),
            view.getFloat32(offset + 16, true),
            view.getFloat32(offset + 20, true),
        );
        if (!Number.isFinite(length) || Math.abs(length - 1) > 0.02)
            throw new Error('Walkability normal must be near unit length.');
        visit(view, offset);
    }
}

function spatialHash(x: number, y: number): number {
    let hash =
        Math.imul(Math.floor(x / 500), 0x45d9f3b) ^ Math.imul(Math.floor(y / 500), 0x119de1f3);
    hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
    return (hash ^ (hash >>> 16)) >>> 0;
}

// Keep whole XY columns, including every vertical layer, at a deterministic hash LOD.
export class PatchSampler {
    private data: Float32Array;
    private count = 0;
    private divisor = 1;
    total = 0;
    constructor(private budget = MAX_PATCHES) {
        if (!Number.isInteger(budget) || budget < 1) throw new Error('Invalid patch budget.');
        this.data = new Float32Array(budget * 6);
    }
    add(view: DataView, offset: number): void {
        this.total++;
        const hash = spatialHash(view.getFloat32(offset, true), view.getFloat32(offset + 4, true));
        if (hash % this.divisor !== 0) return;
        while (this.count === this.budget) {
            if (this.divisor >= 0x100000000)
                throw new Error('Too many coincident vertical layers for the walkability budget.');
            this.divisor *= 2;
            let kept = 0;
            for (let i = 0; i < this.count; i++) {
                if (spatialHash(this.data[i * 6], this.data[i * 6 + 1]) % this.divisor !== 0)
                    continue;
                this.data.copyWithin(kept++ * 6, i * 6, i * 6 + 6);
            }
            this.count = kept;
            if (hash % this.divisor !== 0) return;
        }
        for (let i = 0; i < 6; i++)
            this.data[this.count * 6 + i] = view.getFloat32(offset + i * 4, true);
        this.count++;
    }
    finish(): Float32Array {
        return this.data.slice(0, this.count * 6);
    }
}

export interface WalkabilityData {
    manifest: WalkabilityManifest;
    records: Float32Array;
    total: number;
}
export async function loadWalkability(
    url: string,
    mapKey: string,
    signal: AbortSignal,
    onManifest: (manifest: WalkabilityManifest) => void,
): Promise<WalkabilityData> {
    const manifestBytes = await boundedResponse(
        await fetch(url, { signal, cache: 'no-store' }),
        4 * 1024 * 1024,
        signal,
    );
    signal.throwIfAborted();
    const manifest = validateWalkability(
        JSON.parse(new TextDecoder().decode(manifestBytes)),
        mapKey,
    );
    onManifest(manifest);
    const sampler = new PatchSampler();
    for (const tile of manifest.tiles) {
        signal.throwIfAborted();
        const bytes = await boundedResponse(
            await fetch(new URL(tile.url, url), { signal }),
            tile.records * 24,
            signal,
        );
        signal.throwIfAborted();
        visitWalkability(bytes, tile, (view, offset) => sampler.add(view, offset));
    }
    return { manifest, records: sampler.finish(), total: sampler.total };
}

export function patchGeometry(records: Float32Array): THREE.InstancedBufferGeometry {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(
            [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0],
            3,
        ),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const instances = new THREE.InstancedInterleavedBuffer(records, 6);
    geometry.setAttribute('sampleXYZ', new THREE.InterleavedBufferAttribute(instances, 3, 0));
    geometry.setAttribute('sampleNormal', new THREE.InterleavedBufferAttribute(instances, 3, 3));
    geometry.instanceCount = records.length / 6;
    return geometry;
}

export function patchMaterial(
    centerX: number,
    centerY: number,
    spacing: number,
): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
        uniforms: {
            center: { value: new THREE.Vector2(centerX, centerY) },
            width: { value: spacing * 0.85 },
        },
        vertexShader: `
            attribute vec3 sampleXYZ;
            attribute vec3 sampleNormal;
            uniform vec2 center;
            uniform float width;
            void main() {
                vec3 n = normalize(sampleNormal);
                vec3 reference = abs(n.z) < 0.9 ? vec3(0.,0.,1.) : vec3(0.,1.,0.);
                vec3 tangent = normalize(cross(reference, n));
                vec3 bitangent = cross(n, tangent);
                vec3 world = sampleXYZ + n * 3.0
                    + width * (position.x * tangent + position.y * bitangent);
                vec3 scene = vec3(world.x - center.x, world.z, world.y - center.y) / 100.0;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(scene, 1.);
            }`,
        fragmentShader: `void main() { gl_FragColor = vec4(0.16, 0.85, 0.28, 1.); }`,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: true,
    });
}

export interface WalkabilityStatus {
    text: string;
    retry?: boolean;
    manifest?: WalkabilityManifest;
}

export function formatWalkabilitySlope(
    manifest: Pick<WalkabilityManifest, 'walkableFloorZ' | 'walkableFloorAngle'>,
): string {
    return `Export slope: floor normal Z ≥ ${manifest.walkableFloorZ.toFixed(4)}, angle ${manifest.walkableFloorAngle.toFixed(1)}°.`;
}

export class WalkabilityLayer {
    readonly group = new THREE.Group();
    private revision = 0;
    private controller?: AbortController;
    constructor(
        private status: (status: WalkabilityStatus) => void,
        private loader = loadWalkability,
    ) {}
    clear(): void {
        this.revision++;
        this.controller?.abort();
        this.controller = undefined;
        for (const child of this.group.children) {
            const mesh = child as THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
        this.group.clear();
    }
    async enable(url: string, mapKey: string, centerX: number, centerY: number): Promise<void> {
        this.clear();
        const revision = this.revision;
        const controller = (this.controller = new AbortController());
        const current = () => revision === this.revision && !controller.signal.aborted;
        this.status({ text: 'Loading all-floor walkable surface candidates…' });
        try {
            const result = await this.loader(url, mapKey, controller.signal, (manifest) => {
                if (current()) this.status({ text: 'Loading all-floor samples…', manifest });
            });
            if (!current()) return;
            const mesh = new THREE.Mesh(
                patchGeometry(result.records),
                patchMaterial(centerX, centerY, result.manifest.spacing),
            );
            // Shader instances use raw world coordinates rather than the tiny base quad bounds.
            mesh.frustumCulled = false;
            mesh.renderOrder = 1;
            this.group.add(mesh);
            const count = result.records.length / 6;
            this.status({
                manifest: result.manifest,
                text: `${count.toLocaleString()} / ${result.total.toLocaleString()} candidate samples displayed.${
                    count < result.total
                        ? ' Display spatially thinned to the 200,000-patch budget; retained XY columns keep all vertical layers.'
                        : ''
                }`,
            });
        } catch (error) {
            if (!current()) return;
            controller.abort();
            this.status({
                text: `Walkable overlay failed: ${error instanceof Error ? error.message : String(error)}`,
                retry: true,
            });
        }
    }
}
