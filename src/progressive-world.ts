import * as THREE from 'three';
import { worldUnitsPerPixel, type MapCamera } from './camera-view.js';
import { displayNumber } from './display-number.js';
import { cubeSeamGeometry, extractCubeSurface, planCubeSeams, type CubeSurface } from './cube-seams.js';
import {
    worldGeometry,
    worldGeometryBytes,
    WORLD_RESIDENT_BYTES,
    WORLD_TRIANGLES,
    type WorldModelManifest,
    type WorldModelStatus,
    type WorldTile,
} from './world-model.js';
import type { CoordinateSystem } from './data/types.js';
import { MAX_TERRAIN_TRIANGLES, TerrainBudget } from './terrain-budget.js';
import { cubeMeshCounts, implicitMeshBytes, worldMeshBytes } from './world-mesh-fetch.js';
import { cubeGridChildren, cubeGridUrl } from './cube-grid.js';

const MORPH_SECONDS = 0.25;
class TerrainBudgetBlocked extends Error {}
type MapBounds = Pick<CoordinateSystem, 'minX' | 'minY' | 'maxX' | 'maxY'>;
interface Context {
    url: string;
    centerX: number;
    centerY: number;
    mapBounds: MapBounds;
}
interface Patch {
    node: WorldTile;
    mesh: THREE.Mesh;
    readyAt: number;
    surface?: CubeSurface;
    seam?: THREE.Mesh;
}
interface Transaction {
    controller: AbortController;
    nodes: WorldTile[];
    loaded: Map<string, THREE.Mesh>;
    surfaces: Map<string, CubeSurface>;
    finishAt?: number;
    remove: string[];
}

export function cubeSizeFactors(near: number, far: number, changed?: 'near' | 'far'): { near: number; far: number } {
    const factors = [1, 2, 4, 8, 16, 32, 64];
    if (!factors.includes(near)) throw new Error('Invalid near cube size factor.');
    if (!factors.includes(far)) throw new Error('Invalid far cube size factor.');
    if (near > far) {
        if (changed === 'near') far = near;
        else if (changed === 'far') near = far;
        else throw new Error('Near cube minimum cannot exceed far cube target.');
    }
    return { near, far };
}

export function morphWeight(start: number, direction: number, time: number): number {
    const progress = THREE.MathUtils.clamp((time - start) / MORPH_SECONDS, 0, 1);
    return direction > 0 ? progress : 1 - progress;
}

export function attachWorldMorph(
    material: THREE.Material,
    time: { value: number },
    bounds: MapBounds,
    centerX: number,
    centerY: number,
): void {
    if (material.userData.worldMorph) return;
    material.userData.worldMorph = true;
    const before = material.onBeforeCompile;
    const cache = material.customProgramCacheKey();
    material.onBeforeCompile = (shader, renderer) => {
        before.call(material, shader, renderer);
        shader.uniforms.worldMorphTime = time;
        shader.uniforms.worldMorphUvOrigin = {
            value: new THREE.Vector2((bounds.minX - centerX) / 100, (bounds.minY - centerY) / 100),
        };
        shader.uniforms.worldMorphUvExtent = {
            value: new THREE.Vector2(
                (bounds.maxX - bounds.minX) / 100,
                (bounds.maxY - bounds.minY) / 100,
            ),
        };
        shader.vertexShader = shader.vertexShader
            .replace(
                '#include <common>',
                `#include <common>
attribute vec3 worldCoarsePosition;
attribute vec2 worldPatchTransition;
uniform float worldMorphTime;
uniform vec2 worldMorphUvOrigin;
uniform vec2 worldMorphUvExtent;
vec3 worldMorphPosition() {
    float progress = clamp((worldMorphTime-worldPatchTransition.x)/${MORPH_SECONDS.toFixed(2)},0.0,1.0);
    float weight = worldPatchTransition.y>0.0 ? progress : 1.0-progress;
    return mix(worldCoarsePosition,position,weight);
}`,
            )
            .replace('#include <begin_vertex>', 'vec3 transformed = worldMorphPosition();')
            .replace('worldColorPosition = position;', 'worldColorPosition = transformed;')
            .replace(
                '#include <uv_vertex>',
                `#include <uv_vertex>
#ifdef USE_UV
    vec2 worldMorphUv = (worldMorphPosition().xz-worldMorphUvOrigin)/worldMorphUvExtent;
    vUv = (uvTransform*vec3(worldMorphUv.x,1.0-worldMorphUv.y,1.0)).xy;
#endif`,
            );
    };
    material.customProgramCacheKey = () => cache + '-progressive-morph-v1';
    material.needsUpdate = true;
}

export class ProgressiveWorld {
    private nodes: Map<string, WorldTile>;
    private parents = new Map<string, WorldTile>();
    private active = new Map<string, Patch>();
    private transaction?: Transaction;
    private failed = new Set<string>();
    private error?: string;
    private initialized = false;
    private disposed = false;
    private selectionMs = 0;
    private cubeSizes = { near: 1, far: 4 };
    private budget: TerrainBudget;
    private budgetLimited = false;
    private buffers = new Map<string, ArrayBuffer>();
    private bufferBytes = 0;
    private get cubes(): boolean {
        return this.manifest.statistics.hierarchyVersion === 3;
    }
    setCubeSizeFactors(near: number, far: number): void {
        this.cubeSizes = cubeSizeFactors(near, far);
    }
    constructor(
        private manifest: WorldModelManifest,
        private context: Context,
        private request: typeof fetch,
        private group: THREE.Group,
        private createMesh: (geometry: THREE.BufferGeometry) => THREE.Mesh,
        private time: { value: number },
        private status: (status: WorldModelStatus) => void,
    ) {
        this.nodes = new Map(manifest.tiles.map((node) => [node.id, node]));
        this.budget = new TerrainBudget(manifest.roots!.reduce((sum, id) => sum + this.nodes.get(id)!.lods[0].triangles, 0));
        for (const node of manifest.tiles)
            for (const child of node.children ?? []) this.parents.set(child, node);
    }
    get meshes(): THREE.Mesh[] {
        return [...this.active.values()].flatMap(p => p.seam ? [p.mesh, p.seam] : [p.mesh]);
    }
    cubeSizeCm(object: THREE.Object3D): number | undefined {
        for (const patch of this.active.values())
            if (patch.mesh === object) return patch.node.lods[0].cubeSizeCm;
        return undefined;
    }
    get allMeshes(): THREE.Mesh[] {
        return [...this.meshes, ...(this.transaction?.loaded.values() ?? [])];
    }
    start(): void {
        if (this.disposed || this.transaction) return;
        this.replace(
            [],
            this.manifest.roots!.map((id) => this.nodes.get(id)!),
            false,
        );
    }
    clear(): void {
        this.disposed = true;
        this.transaction?.controller.abort();
        for (const mesh of this.transaction?.loaded.values() ?? []) mesh.geometry.dispose();
        this.transaction = undefined;
        for (const p of this.active.values()) {
            this.group.remove(p.mesh);
            p.mesh.geometry.dispose();
            if (p.seam) {
                this.group.remove(p.seam);
                p.seam.geometry.dispose();
            }
        }
        this.active.clear();
        this.buffers.clear();
        this.bufferBytes = 0;
    }
    retry(): void {
        this.failed.clear();
        this.error = undefined;
        if (!this.initialized) this.start();
        this.emit();
    }
    animate(): void {
        if (this.cubes && this.initialized) this.budget.sample(this.time.value * 1000, this.budgetLimited);
        const tx = this.transaction;
        if (tx?.finishAt !== undefined && this.time.value >= tx.finishAt) this.commit(tx, false);
    }
    update(camera: MapCamera, height: number, exaggeration: number): void {
        if (!this.initialized || this.transaction || this.disposed) return;
        const started = performance.now();
        camera.updateMatrixWorld();
        const frustum = new THREE.Frustum().setFromProjectionMatrix(
            new THREE.Matrix4().multiplyMatrices(
                camera.projectionMatrix,
                camera.matrixWorldInverse,
            ),
        );
        const cubes = this.cubes;
        const focusRay = new THREE.Ray(camera.position, camera.getWorldDirection(new THREE.Vector3()));
        const error = (node: WorldTile) => {
            const b = node.bounds;
            const box = new THREE.Box3(
                new THREE.Vector3(
                    (b.minX - this.context.centerX) / 100,
                    (b.minZ * exaggeration) / 100,
                    (b.minY - this.context.centerY) / 100,
                ),
                new THREE.Vector3(
                    (b.maxX - this.context.centerX) / 100,
                    (b.maxZ * exaggeration) / 100,
                    (b.maxY - this.context.centerY) / 100,
                ),
            );
            const visible = frustum.intersectsBox(box);
            if (cubes && visible) {
                const distance = box.distanceToPoint(camera.position);
                const target = this.manifest.cellSizeCm * (distance < 750 ? this.cubeSizes.near : this.cubeSizes.far);
                return node.lods[0].cubeSizeCm! > target
                    ? 3 + node.lods[0].cubeSizeCm! / target *
                        (focusRay.intersectsBox(box) ? 16 : 1) / (1 + distance / 128)
                    : 0.5;
            }
            return visible
                ? ((node.lods[0].maxErrorCm / 100) * Math.max(1, exaggeration)) /
                      worldUnitsPerPixel(camera, height, Math.max(1, box.distanceToPoint(camera.position)))
                : 0;
        };
        const current = [...this.active.values()];
        if (this.manifest.grid)
            for (const patch of current) {
                if (patch.node.children !== undefined) continue;
                const children = cubeGridChildren(this.manifest, patch.node);
                patch.node.children = children.map(child => child.id);
                for (const child of children) {
                    if (!this.nodes.has(child.id)) this.nodes.set(child.id, child);
                    this.parents.set(child.id, patch.node);
                }
            }
        const refine = current
            .filter(
                (p) =>
                    p.readyAt <= this.time.value &&
                    p.node.children?.length &&
                    !this.failed.has(p.node.id),
            )
            .map((p) => ({ patch: p, error: error(p.node) }))
            .filter((p) => p.error > 2)
            .sort((a, b) => b.error - a.error || a.patch.node.id.localeCompare(b.patch.node.id));
        const parents = new Map<string, WorldTile>();
        for (const patch of current) {
            const parent = this.parents.get(patch.node.id);
            if (parent) parents.set(parent.id, parent);
        }
        const coarsen = [...parents.values()]
            .filter(
                (parent) =>
                    !this.failed.has(parent.id) &&
                    parent.children!.every(
                        (id) => (this.active.get(id)?.readyAt ?? Infinity) <= this.time.value,
                    ),
            )
            .map((node) => ({ node, error: error(node) }))
            .sort((a, b) => a.error - b.error);
        const overBudget = cubes && current.reduce((sum, p) => sum + p.node.lods[0].triangles, 0) > this.budget.triangles;
        const cheap = coarsen.find((p) => p.error < 1 || overBudget);
        this.budgetLimited = false;
        if (cheap && this.fits(cheap.node.children!, [cheap.node]))
            this.replace(cheap.node.children!, [cheap.node], true);
        else {
            for (const candidate of refine) {
                const node = candidate.patch.node;
                const children = node.children!.map((id) => this.nodes.get(id)!);
                if (this.fits([node.id], children)) {
                    this.replace([node.id], children, false);
                    break;
                }
                this.budgetLimited = true;
                const reclaimed: WorldTile[] = [];
                let reclaim: WorldTile | undefined;
                for (const parent of coarsen) {
                    if (parent.error >= candidate.error * 0.5 || parent.node.children!.includes(node.id) ||
                        !this.fits(parent.node.children!, [parent.node], reclaimed)) continue;
                    reclaimed.push(parent.node);
                    if (this.fits([node.id], children, reclaimed)) {
                        reclaim = reclaimed[0];
                        break;
                    }
                }
                // Only release detail when the resulting frontier can actually admit the higher-priority patch.
                if (reclaim) {
                    this.replace(reclaim.children!, [reclaim], true);
                    break;
                }
            }
        }
        this.selectionMs = performance.now() - started;
        this.emit();
    }
    private fits(remove: string[], add: WorldTile[], coarsened: WorldTile[] = []): boolean {
        let triangles = 0,
            bytes = 0;
        const replaced = new Set(coarsened.flatMap(node => node.children!));
        for (const p of this.active.values()) {
            if (replaced.has(p.node.id)) continue;
            bytes += worldGeometryBytes(p.node.lods[0]);
            if (!remove.includes(p.node.id)) triangles += p.node.lods[0].triangles;
        }
        for (const node of coarsened) {
            bytes += worldGeometryBytes(node.lods[0]);
            if (!remove.includes(node.id)) triangles += node.lods[0].triangles;
        }
        for (const node of add) {
            triangles += node.lods[0].triangles;
            bytes += worldGeometryBytes(node.lods[0]);
        }
        const currentTriangles = [...this.active.values()].reduce((sum, p) => sum + p.node.lods[0].triangles, 0);
        const coarsening = add.every(node => node.children?.every(id => remove.includes(id)));
        const triangleLimit = this.cubes
            ? Math.max(this.budget.triangles, coarsening ? currentTriangles - 1 : 0)
            : WORLD_TRIANGLES;
        return triangles <= triangleLimit && bytes <= WORLD_RESIDENT_BYTES;
    }
    private replace(remove: string[], nodes: WorldTile[], coarsening: boolean): void {
        if (!this.fits(remove, nodes)) return;
        const tx: Transaction = {
            controller: new AbortController(),
            nodes,
            remove,
            loaded: new Map(),
            surfaces: new Map(),
        };
        this.transaction = tx;
        this.emit();
        let cursor = 0;
        const discover = async () => {
            const grid = this.manifest.grid;
            if (!grid) return;
            for (const node of nodes) {
                const lod = node.lods[0];
                if (lod.discovered !== false) continue;
                lod.url = await cubeGridUrl(grid, node.id, this.context.url);
                tx.controller.signal.throwIfAborted();
                const bytes = await implicitMeshBytes(this.request, lod.url, tx.controller.signal);
                tx.controller.signal.throwIfAborted();
                Object.assign(lod, cubeMeshCounts(bytes), { discovered: true });
                while (this.bufferBytes + bytes.byteLength > 32 * 1024 * 1024 && this.buffers.size) {
                    const oldest = this.buffers.keys().next().value!;
                    this.bufferBytes -= this.buffers.get(oldest)!.byteLength;
                    this.buffers.delete(oldest);
                }
                this.buffers.set(node.id, bytes);
                this.bufferBytes += bytes.byteLength;
            }
            if (!remove.length && !this.initialized) {
                if (nodes.reduce((sum, node) => sum + node.lods[0].triangles, 0) > WORLD_TRIANGLES)
                    throw new Error('Complete implicit cube base exceeds one million triangles.');
            }
            if (!this.fits(remove, nodes)) {
                if (!this.initialized) throw new Error('Complete implicit cube base exceeds geometry memory limits.');
                throw new TerrainBudgetBlocked();
            }
        };
        const load = async () => {
            while (cursor < nodes.length) {
                const node = nodes[cursor++],
                    descriptor = node.lods[0];
                let bytes = this.buffers.get(node.id);
                if (bytes) {
                    this.buffers.delete(node.id);
                    this.bufferBytes -= bytes.byteLength;
                } else bytes = this.manifest.grid
                    ? await implicitMeshBytes(this.request, descriptor.url, tx.controller.signal)
                    : await worldMeshBytes(this.request, new URL(descriptor.url, this.context.url),
                        descriptor, tx.controller.signal);
                tx.controller.signal.throwIfAborted();
                const geometry = worldGeometry(
                    bytes,
                    descriptor,
                    node.bounds,
                    this.context.centerX,
                    this.context.centerY,
                    this.context.mapBounds,
                    this.cubes,
                    this.manifest.statistics.partitionDimensions === 3,
                );
                const mesh = this.createMesh(geometry);
                tx.loaded.set(node.id, mesh);
                if (this.cubes && this.manifest.statistics.seamPolicy === 'closed-voxel-partitions-v1')
                    tx.surfaces.set(node.id, extractCubeSurface(
                        geometry, node, this.context.centerX, this.context.centerY,
                        this.manifest.statistics.partitionDimensions === 3,
                    ));
                if (!this.cubes) this.installPicking(mesh);
            }
        };
        void discover().then(() => Promise.all(Array.from({ length: Math.min(2, nodes.length) }, load)))
            .then(() => {
                if (this.transaction !== tx || this.disposed) return;
                if (coarsening && !this.cubes) {
                    tx.finishAt = this.time.value + MORPH_SECONDS;
                    for (const id of remove) this.transition(this.active.get(id)!.mesh, -1);
                } else this.commit(tx, this.initialized && !this.cubes);
            })
            .catch((failure: unknown) => {
                if (this.transaction !== tx || this.disposed) return;
                tx.controller.abort();
                for (const mesh of tx.loaded.values()) mesh.geometry.dispose();
                this.transaction = undefined;
                if (failure instanceof TerrainBudgetBlocked && this.initialized) {
                    this.budgetLimited = true;
                    this.emit();
                    return;
                }
                for (const id of coarsening || !remove.length ? nodes.map((n) => n.id) : remove)
                    this.failed.add(id);
                this.error = failure instanceof Error ? failure.message : String(failure);
                this.emit();
            });
    }
    private commit(tx: Transaction, morph: boolean): void {
        const next = new Map(this.active);
        for (const id of tx.remove) next.delete(id);
        for (const node of tx.nodes)
            next.set(node.id, {
                node,
                mesh: tx.loaded.get(node.id)!,
                surface: tx.surfaces.get(node.id),
                readyAt: this.time.value + (morph ? MORPH_SECONDS : 0),
            });
        const patches = [...next.values()].filter((p): p is Patch & { surface: CubeSurface } => !!p.surface);
        const plans = planCubeSeams(patches.map(p => p.surface));
        if (patches.length) {
            const bytes = (mesh: THREE.Mesh) => mesh.geometry.getAttribute('position').count * 32 +
                (mesh.geometry.index?.count ?? 0) * 4;
            const finalTriangles = [...next.values()].reduce((sum, p) => sum + (p.mesh.geometry.index?.count ?? 0) / 3, 0) +
                plans.reduce((sum, plan) => sum + plan.faces.length * 2, 0);
            const residentBytes = this.meshes.reduce((sum, mesh) => sum + bytes(mesh), 0) +
                [...tx.loaded.values()].reduce((sum, mesh) => sum + bytes(mesh), 0) +
                plans.reduce((sum, plan) => sum + plan.faces.length * (4 * 32 + 6 * 4), 0);
            if (finalTriangles > (this.cubes ? MAX_TERRAIN_TRIANGLES : WORLD_TRIANGLES) || residentBytes > WORLD_RESIDENT_BYTES)
                throw new Error('Neighbor-aware cube seams exceed the geometry budget.');
        }
        const seams = plans.map(plan => plan.faces.length ? this.createMesh(cubeSeamGeometry(
            plan, this.context.mapBounds, this.context.centerX, this.context.centerY,
        )) : undefined);
        for (const patch of this.active.values())
            if (patch.seam) {
                this.group.remove(patch.seam);
                patch.seam.geometry.dispose();
                patch.seam = undefined;
            }
        for (const id of tx.remove) {
            const patch = this.active.get(id)!;
            this.group.remove(patch.mesh);
            patch.mesh.geometry.dispose();
            this.active.delete(id);
        }
        for (const node of tx.nodes) {
            const mesh = tx.loaded.get(node.id)!;
            if (morph) this.transition(mesh, 1);
            this.active.set(node.id, next.get(node.id)!);
            this.group.add(mesh);
        }
        patches.forEach((patch, i) => {
            patch.seam = seams[i];
            if (patch.seam) this.group.add(patch.seam);
        });
        this.transaction = undefined;
        if (!this.initialized && this.manifest.grid)
            this.budget = new TerrainBudget(tx.nodes.reduce((sum, node) => sum + node.lods[0].triangles, 0));
        this.initialized = true;
        this.emit();
    }
    private transition(mesh: THREE.Mesh, direction: number): void {
        const attr = mesh.geometry.getAttribute('worldPatchTransition') as THREE.BufferAttribute;
        for (let i = 0; i < attr.count; i++) attr.setXY(i, this.time.value, direction);
        attr.needsUpdate = true;
    }
    private installPicking(mesh: THREE.Mesh): void {
        mesh.raycast = (ray, hits) => {
            const geometry = mesh.geometry;
            const transition = geometry.getAttribute('worldPatchTransition');
            const weight = morphWeight(transition.getX(0), transition.getY(0), this.time.value);
            if (weight === 1) {
                THREE.Mesh.prototype.raycast.call(mesh, ray, hits);
                return;
            }
            // Only pointer raycasts evaluate positions on the CPU; frame updates only change time.
            const positions = geometry.getAttribute('position'),
                coarse = geometry.getAttribute('worldCoarsePosition');
            const mixed = new Float32Array(positions.count * 3);
            for (let i = 0; i < positions.count; i++)
                for (let axis = 0; axis < 3; axis++)
                    mixed[i * 3 + axis] =
                        coarse.array[i * 3 + axis] * (1 - weight) +
                        positions.array[i * 3 + axis] * weight;
            const temporary = new THREE.BufferGeometry();
            temporary.setAttribute('position', new THREE.BufferAttribute(mixed, 3));
            temporary.setAttribute('uv', geometry.getAttribute('uv'));
            temporary.setIndex(geometry.index);
            temporary.groups = geometry.groups;
            try {
                mesh.geometry = temporary;
                THREE.Mesh.prototype.raycast.call(mesh, ray, hits);
            } finally {
                mesh.geometry = geometry;
                temporary.dispose();
            }
        };
    }
    private emit(): void {
        const triangles = [...this.active.values()].reduce(
            (sum, p) => sum + (p.mesh.geometry.index?.count ?? 0) / 3 + (p.seam?.geometry.index?.count ?? 0) / 3,
            0,
        );
        this.status({
            retry: !!this.error,
            text:
                `${this.cubes ? 'Cubes' : 'Triangles'}: ${this.active.size.toLocaleString()} patches, ${triangles.toLocaleString()} triangles. ` +
                (this.cubes
                    ? `${displayNumber(this.manifest.cellSizeCm * this.cubeSizes.near / 100)} m nearby target; far target ${displayNumber(this.manifest.cellSizeCm * this.cubeSizes.far / 100)} m. Complete coarse coverage retained; adaptive budget ${this.budget.triangles.toLocaleString()} triangles, 96 MiB.`
                    : `Hierarchy selection ${this.selectionMs.toFixed(2)} ms; GPU geomorphing.`) +
                (!this.initialized
                    ? ' Loading complete 3D base; no surface displayed until ready.'
                    : '') +
                (this.transaction ? ' Streaming…' : '') +
                (this.budgetLimited ? ' Detail blocked by geometry budget.' : '') +
                (this.error
                    ? ` Patch failed: ${this.error}. ${this.initialized ? 'Previous complete surface retained' : 'No 3D base loaded'}; retry available.`
                    : ''),
        });
    }
}
