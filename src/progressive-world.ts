import * as THREE from 'three';
import { worldUnitsPerPixel, type MapCamera } from './camera-view.js';
import { displayNumber } from './display-number.js';
import { boundedResponse } from './bounded-response.js';
import {
    worldBinaryBytes,
    worldGeometry,
    worldGeometryBytes,
    WORLD_RESIDENT_BYTES,
    WORLD_TRIANGLES,
    type WorldModelManifest,
    type WorldModelStatus,
    type WorldTile,
} from './world-model.js';
import type { CoordinateSystem } from './data/types.js';

const MORPH_SECONDS = 0.25;
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
}
interface Transaction {
    controller: AbortController;
    nodes: WorldTile[];
    loaded: Map<string, THREE.Mesh>;
    finishAt?: number;
    remove: string[];
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
    private cubeSizeFactor = 4;
    private get cubes(): boolean {
        return this.manifest.statistics.hierarchyVersion === 3;
    }
    setCubeSizeFactor(factor: number): void {
        if (![1, 2, 4, 8, 16, 32, 64].includes(factor)) throw new Error('Invalid far cube size factor.');
        this.cubeSizeFactor = factor;
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
        for (const node of manifest.tiles)
            for (const child of node.children ?? []) this.parents.set(child, node);
    }
    get meshes(): THREE.Mesh[] {
        return [...this.active.values()].map((p) => p.mesh);
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
        }
        this.active.clear();
    }
    retry(): void {
        this.failed.clear();
        this.error = undefined;
        if (!this.initialized) this.start();
        this.emit();
    }
    animate(): void {
        const tx = this.transaction;
        if (tx?.finishAt !== undefined && this.time.value >= tx.finishAt) this.commit(tx, false);
    }
    update(camera: MapCamera, height: number, exaggeration: number, focus = new THREE.Vector3()): void {
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
                const distance = camera instanceof THREE.OrthographicCamera
                    ? Math.hypot(box.distanceToPoint(focus), worldUnitsPerPixel(camera, height, 1) * height / 2)
                    : box.distanceToPoint(camera.position);
                const target = this.manifest.cellSizeCm * (distance < 750 ? 1 : this.cubeSizeFactor);
                return node.lods[0].cubeSizeCm! > target
                    ? 3 + node.lods[0].cubeSizeCm! / target / (1 + distance / 1000)
                    : 0.5;
            }
            return visible
                ? ((node.lods[0].maxErrorCm / 100) * Math.max(1, exaggeration)) /
                      worldUnitsPerPixel(camera, height, Math.max(1, box.distanceToPoint(camera.position)))
                : 0;
        };
        const current = [...this.active.values()];
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
        const cheap = coarsen.find((p) => p.error < 1);
        if (cheap && this.fits(cheap.node.children!, [cheap.node]))
            this.replace(cheap.node.children!, [cheap.node], true);
        else {
            const next = refine.find((p) =>
                this.fits(
                    [p.patch.node.id],
                    p.patch.node.children!.map((id) => this.nodes.get(id)!),
                ),
            );
            if (next)
                this.replace(
                    [next.patch.node.id],
                    next.patch.node.children!.map((id) => this.nodes.get(id)!),
                    false,
                );
            else if (refine.length) {
                const reclaim = coarsen.find(
                    (p) => p.error < refine[0].error * 0.5 && this.fits(p.node.children!, [p.node]),
                );
                if (reclaim) this.replace(reclaim.node.children!, [reclaim.node], true);
            }
        }
        this.selectionMs = performance.now() - started;
        this.emit();
    }
    private fits(remove: string[], add: WorldTile[]): boolean {
        let triangles = 0,
            bytes = 0;
        for (const p of this.active.values()) {
            bytes += worldGeometryBytes(p.node.lods[0]);
            if (!remove.includes(p.node.id)) triangles += p.node.lods[0].triangles;
        }
        for (const node of add) {
            triangles += node.lods[0].triangles;
            bytes += worldGeometryBytes(node.lods[0]);
        }
        return triangles <= WORLD_TRIANGLES && bytes <= WORLD_RESIDENT_BYTES;
    }
    private replace(remove: string[], nodes: WorldTile[], coarsening: boolean): void {
        if (!this.fits(remove, nodes)) return;
        const tx: Transaction = {
            controller: new AbortController(),
            nodes,
            remove,
            loaded: new Map(),
        };
        this.transaction = tx;
        this.emit();
        let cursor = 0;
        const load = async () => {
            while (cursor < nodes.length) {
                const node = nodes[cursor++],
                    descriptor = node.lods[0];
                const bytes = await boundedResponse(
                    await this.request(new URL(descriptor.url, this.context.url), {
                        signal: tx.controller.signal,
                    }),
                    worldBinaryBytes(descriptor),
                    tx.controller.signal,
                    'Progressive patch',
                );
                tx.controller.signal.throwIfAborted();
                const geometry = worldGeometry(
                    bytes,
                    descriptor,
                    node.bounds,
                    this.context.centerX,
                    this.context.centerY,
                    this.context.mapBounds,
                    this.cubes,
                );
                const mesh = this.createMesh(geometry);
                if (!this.cubes) this.installPicking(mesh);
                tx.loaded.set(node.id, mesh);
            }
        };
        void Promise.all(Array.from({ length: Math.min(2, nodes.length) }, load))
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
                for (const id of coarsening || !remove.length ? nodes.map((n) => n.id) : remove)
                    this.failed.add(id);
                this.error = failure instanceof Error ? failure.message : String(failure);
                this.emit();
            });
    }
    private commit(tx: Transaction, morph: boolean): void {
        for (const id of tx.remove) {
            const patch = this.active.get(id)!;
            this.group.remove(patch.mesh);
            patch.mesh.geometry.dispose();
            this.active.delete(id);
        }
        for (const node of tx.nodes) {
            const mesh = tx.loaded.get(node.id)!;
            if (morph) this.transition(mesh, 1);
            this.active.set(node.id, {
                node,
                mesh,
                readyAt: this.time.value + (morph ? MORPH_SECONDS : 0),
            });
            this.group.add(mesh);
        }
        this.transaction = undefined;
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
            (sum, p) => sum + p.node.lods[0].triangles,
            0,
        );
        this.status({
            retry: !!this.error,
            text:
                `${this.cubes ? 'Cubes' : 'Triangles'}: ${this.active.size.toLocaleString()} patches, ${triangles.toLocaleString()} triangles. ` +
                (this.cubes
                    ? `${displayNumber(this.manifest.cellSizeCm / 100)} m nearby target; far target ${displayNumber(this.manifest.cellSizeCm * this.cubeSizeFactor / 100)} m. Complete coarse coverage retained; detail is budget-limited.`
                    : `Hierarchy selection ${this.selectionMs.toFixed(2)} ms; GPU geomorphing.`) +
                (!this.initialized
                    ? ' Loading complete 3D base; no surface displayed until ready.'
                    : '') +
                (this.transaction ? ' Streaming…' : '') +
                (this.error
                    ? ` Patch failed: ${this.error}. ${this.initialized ? 'Previous complete surface retained' : 'No 3D base loaded'}; retry available.`
                    : ''),
        });
    }
}
