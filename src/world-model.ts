import * as THREE from 'three';
import { worldUnitsPerPixel, type MapCamera } from './camera-view.js';
import { boundedResponse } from './bounded-response.js';
import type { CoordinateSystem } from './data/types.js';
import { ProgressiveWorld, attachWorldMorph } from './progressive-world.js';

export const WORLD_TILE_BYTES = 32 * 1024 * 1024;
export const WORLD_RESIDENT_BYTES = 96 * 1024 * 1024;
export const WORLD_TRIANGLES = 1_000_000;
export interface WorldBounds {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
}
export interface WorldLod {
    url: string;
    vertices: number;
    triangles: number;
    maxErrorCm: number;
    morph?: boolean;
    cubeSizeCm?: number;
}
export interface WorldTile {
    id: string;
    bounds: WorldBounds;
    lods: WorldLod[];
    children?: string[];
}
export interface WorldModelManifest {
    version: 1;
    mapKey: string;
    heightUnits: 'centimeters';
    meshFormat: 'awm1';
    cellSizeCm: number;
    tileSizeCm: number;
    maxErrorCm: number;
    bounds: WorldBounds;
    warnings: string[];
    statistics: Record<string, unknown>;
    tiles: WorldTile[];
    roots?: string[];
}

function object(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('Invalid world-model object.');
    return value as Record<string, unknown>;
}
function number(value: unknown, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
        throw new Error('Invalid world-model numeric value.');
    return value;
}
function integer(value: unknown, min: number, max: number): number {
    const result = number(value, min, max);
    if (!Number.isSafeInteger(result)) throw new Error('Invalid world-model integer.');
    return result;
}
function text(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid world-model text.');
    return value;
}
function bounds(value: unknown, patch = false): WorldBounds {
    const b = object(value);
    const coordinate = (name: string) => number(b[name], -100_000_000, 100_000_000);
    const result = {
        minX: coordinate('minX'),
        minY: coordinate('minY'),
        minZ: coordinate('minZ'),
        maxX: coordinate('maxX'),
        maxY: coordinate('maxY'),
        maxZ: coordinate('maxZ'),
    };
    if (
        (patch ? result.minX > result.maxX : result.minX >= result.maxX) ||
        (patch ? result.minY > result.maxY : result.minY >= result.maxY) ||
        result.minZ > result.maxZ
    )
        throw new Error('Invalid world-model bounds.');
    return result;
}
export function worldBinaryBytes(lod: WorldLod): number {
    return 16 + lod.vertices * (lod.morph ? 24 : 12) + lod.triangles * 13;
}
export function worldGeometryBytes(lod: WorldLod): number {
    return lod.vertices * (lod.morph ? 52 : 32) + lod.triangles * 12;
}
export function validateWorldModel(value: unknown, mapKey: string): WorldModelManifest {
    const v = object(value);
    const progressive = v.roots !== undefined;
    const statistics = object(v.statistics);
    const cubes = progressive && statistics.hierarchyVersion === 3;
    if (
        v.version !== 1 ||
        v.mapKey !== mapKey ||
        v.heightUnits !== 'centimeters' ||
        v.meshFormat !== 'awm1' ||
        !Array.isArray(v.tiles) ||
        !v.tiles.length ||
        v.tiles.length > (progressive ? 262144 : 16384) ||
        !Array.isArray(v.warnings) ||
        !v.warnings.every((w) => typeof w === 'string')
    )
        throw new Error('Invalid world-model manifest.');
    const b = bounds(v.bounds, progressive);
    const tileSize = number(v.tileSizeCm, 1, 1_000_000);
    if (
        !progressive &&
        (Math.ceil((b.maxX - b.minX) / tileSize) > 2048 ||
            Math.ceil((b.maxY - b.minY) / tileSize) > 2048)
    )
        throw new Error('World-model coverage grid is too large.');
    const ids = new Set<string>();
    const cells = new Set<string>();
    const tiles = v.tiles.map((raw: unknown): WorldTile => {
        const t = object(raw),
            id = text(t.id),
            box = bounds(t.bounds, progressive);
        const column = Math.round((box.minX - b.minX) / tileSize);
        const row = Math.round((box.minY - b.minY) / tileSize);
        const cell = `${column},${row}`;
        if (
            ids.has(id) ||
            box.minX < b.minX - 0.1 ||
            box.maxX > b.maxX + 0.1 ||
            box.minY < b.minY - 0.1 ||
            box.maxY > b.maxY + 0.1 ||
            box.minZ < b.minZ - 0.1 ||
            box.maxZ > b.maxZ + 0.1 ||
            (!progressive &&
                (cells.has(cell) ||
                    box.minX < b.minX ||
                    box.minY < b.minY ||
                    box.maxX > b.maxX + 0.1 ||
                    box.maxY > b.maxY + 0.1 ||
                    box.minZ < b.minZ - 0.1 ||
                    box.maxZ > b.maxZ + 0.1 ||
                    Math.abs(box.minX - b.minX - column * tileSize) > 0.1 ||
                    Math.abs(box.minY - b.minY - row * tileSize) > 0.1 ||
                    Math.abs(box.maxX - Math.min(b.maxX, box.minX + tileSize)) > 0.1 ||
                    Math.abs(box.maxY - Math.min(b.maxY, box.minY + tileSize)) > 0.1)) ||
            !Array.isArray(t.lods) ||
            !t.lods.length ||
            t.lods.length > 8
        )
            throw new Error('Invalid/overlapping world-model tile grid.');
        ids.add(id);
        cells.add(cell);
        let previousError = -1;
        const lods = t.lods.map((rawLod: unknown): WorldLod => {
            const l = object(rawLod);
            const lod: WorldLod = {
                url: text(l.url),
                vertices: integer(l.vertices, 3, 10_000_000),
                triangles: integer(l.triangles, 1, 10_000_000),
                maxErrorCm: number(l.maxErrorCm, 0, 100_000),
                ...(cubes
                    ? { cubeSizeCm: number(l.cubeSizeCm, 100, 6400) }
                    : progressive
                      ? { morph: true }
                      : {}),
            };
            if (progressive && !cubes && l.morph !== true)
                throw new Error('Progressive patches require collapse correspondence.');
            if (
                cubes &&
                (l.morph === true || ![100, 200, 400, 800, 1600, 3200, 6400].includes(lod.cubeSizeCm!))
            )
                throw new Error('Cube patches require aligned non-morphing cube sizes.');
            if (
                (/^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i.test(lod.url) &&
                    !/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/[a-z0-9-]+\/managed\/v1\/[0-9a-f]{64}\.(?:awm|awp)$/.test(lod.url)) ||
                /[\s\\]/.test(lod.url) ||
                lod.url.split('/').includes('..') ||
                worldBinaryBytes(lod) > WORLD_TILE_BYTES ||
                lod.maxErrorCm < previousError
            )
                throw new Error('Invalid world-model LOD, mesh URL or 32 MiB tile budget.');
            previousError = lod.maxErrorCm;
            return lod;
        });
        const children = progressive ? t.children : undefined;
        if (
            progressive &&
            (!Array.isArray(children) ||
                children.length > 8 ||
                !children.every((child) => typeof child === 'string') ||
                lods.length !== 1)
        )
            throw new Error('Invalid progressive children.');
        return {
            id,
            bounds: box,
            lods,
            ...(progressive ? { children: children as string[] } : {}),
        };
    });
    let roots: string[] | undefined;
    if (progressive) {
        if (
            (statistics.hierarchyVersion !== 1 && statistics.hierarchyVersion !== 2 && !cubes) ||
            (statistics.hierarchyVersion === 2 &&
                statistics.seamPolicy !== 'fixed-interface-collar-v1') ||
            (cubes &&
                (statistics.seamPolicy !== 'closed-voxel-partitions-v1' ||
                    statistics.representation !== 'blocks' || statistics.complete !== true))
        )
            throw new Error('Unsupported progressive hierarchy or refinement seam policy.');
        if (
            !Array.isArray(v.roots) ||
            !v.roots.length ||
            (statistics.hierarchyVersion === 2 && v.roots.length !== 1) ||
            !v.roots.every((root) => typeof root === 'string')
        )
            throw new Error('Invalid progressive roots.');
        roots = v.roots as string[];
        const byId = new Map(tiles.map((tile) => [tile.id, tile]));
        const visited = new Set<string>();
        const visit = (id: string, parent: WorldTile | undefined, depth: number) => {
            const node = byId.get(id);
            if (!node || visited.has(id) || depth > 64)
                throw new Error('Progressive hierarchy has missing, shared or cyclic nodes.');
            if (
                parent &&
                (node.lods[0].maxErrorCm > parent.lods[0].maxErrorCm ||
                    (cubes && node.lods[0].cubeSizeCm !== parent.lods[0].cubeSizeCm! / 2) ||
                    node.bounds.minX < parent.bounds.minX - 0.1 ||
                    node.bounds.maxX > parent.bounds.maxX + 0.1 ||
                    node.bounds.minY < parent.bounds.minY - 0.1 ||
                    node.bounds.maxY > parent.bounds.maxY + 0.1 ||
                    node.bounds.minZ < parent.bounds.minZ - 0.1 ||
                    node.bounds.maxZ > parent.bounds.maxZ + 0.1)
            )
                throw new Error('Progressive child exceeds parent bounds or error.');
            visited.add(id);
            for (const child of node.children ?? []) visit(child, node, depth + 1);
        };
        for (const root of roots) visit(root, undefined, 0);
        if (visited.size !== tiles.length) throw new Error('Unreachable progressive patches.');
        const base = roots.map((id) => byId.get(id)!);
        if (cubes)
            for (let i = 0; i < base.length; i++)
                for (let j = 0; j < i; j++) {
                    const a = base[i].bounds, b = base[j].bounds;
                    if (
                        Math.min(a.maxX, b.maxX) > Math.max(a.minX, b.minX) &&
                        Math.min(a.maxY, b.maxY) > Math.max(a.minY, b.minY)
                    )
                        throw new Error('Overlapping complete-base cube partitions.');
                }
        if (
            base.reduce((sum, tile) => sum + tile.lods[0].triangles, 0) > WORLD_TRIANGLES ||
            base.reduce((sum, tile) => sum + worldGeometryBytes(tile.lods[0]), 0) >
                WORLD_RESIDENT_BYTES
        )
            throw new Error('Complete progressive base exceeds geometry budgets.');
    }
    return {
        version: 1,
        mapKey,
        heightUnits: 'centimeters',
        meshFormat: 'awm1',
        cellSizeCm: number(v.cellSizeCm, 0.1, 10000),
        tileSizeCm: tileSize,
        maxErrorCm: number(v.maxErrorCm, 0, 100_000),
        bounds: b,
        warnings: v.warnings,
        statistics,
        tiles,
        ...(roots ? { roots } : {}),
    };
}

export function worldGeometry(
    buffer: ArrayBuffer,
    lod: WorldLod,
    box: WorldBounds,
    centerX: number,
    centerY: number,
    mapBounds: Pick<CoordinateSystem, 'minX' | 'minY' | 'maxX' | 'maxY'>,
    textureBlockSides = false,
): THREE.BufferGeometry {
    const view = new DataView(buffer);
    if (
        buffer.byteLength !== worldBinaryBytes(lod) ||
        view.getUint32(0, true) !== (lod.morph ? 0x31505741 : 0x314d5741) ||
        view.getUint32(4, true) !== lod.vertices ||
        view.getUint32(8, true) !== lod.triangles ||
        view.getUint32(12, true) !== 0
    )
        throw new Error('Invalid AWM1 header or binary length.');
    if (mapBounds.minX >= mapBounds.maxX || mapBounds.minY >= mapBounds.maxY)
        throw new Error('Invalid world-model map coordinates.');
    const positions = new Float32Array(lod.vertices * 3);
    const uvs = new Float32Array(lod.vertices * 2);
    const cubeOrigins = [box.minX, box.minY, box.minZ];
    const cubeMaxima = [box.maxX, box.maxY, box.maxZ];
    for (let i = 0; i < lod.vertices; i++) {
        const x = view.getFloat32(16 + i * 12, true);
        const y = view.getFloat32(20 + i * 12, true);
        const z = view.getFloat32(24 + i * 12, true);
        if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            !Number.isFinite(z) ||
            x < box.minX - 0.1 ||
            x > box.maxX + 0.1 ||
            y < box.minY - 0.1 ||
            y > box.maxY + 0.1 ||
            z < box.minZ - 0.1 ||
            z > box.maxZ + 0.1
        )
            throw new Error('World-model vertex outside declared bounds.');
        if (lod.cubeSizeCm) {
            for (let axis = 0; axis < 3; axis++) {
                const position = axis === 0 ? x : axis === 1 ? y : z;
                const snapped = cubeOrigins[axis] +
                    Math.round((position - cubeOrigins[axis]) / lod.cubeSizeCm) * lod.cubeSizeCm;
                if (Math.abs(position - snapped) > .05 && Math.abs(position - cubeMaxima[axis]) > .05)
                    throw new Error('Cube vertex is not on the declared lattice.');
            }
        }
        positions[i * 3] = (x - centerX) / 100;
        positions[i * 3 + 1] = z / 100;
        positions[i * 3 + 2] = (y - centerY) / 100;
        uvs[i * 2] = (x - mapBounds.minX) / (mapBounds.maxX - mapBounds.minX);
        uvs[i * 2 + 1] = 1 - (y - mapBounds.minY) / (mapBounds.maxY - mapBounds.minY);
    }
    const indexStart = 16 + lod.vertices * 12;
    const flagStart = indexStart + lod.triangles * 12;
    const counts = [0, 0, 0, 0, 0];
    const surfaceGroups = new Uint8Array(lod.triangles);
    const coordinate = (vertex: number, axis: number) =>
        view.getFloat32(16 + vertex * 12 + axis * 4, true);
    for (let i = 0; i < lod.triangles; i++) {
        const flag = view.getUint8(flagStart + i);
        if (flag > 3) throw new Error('Unknown world-model surface flags.');
        const a = view.getUint32(indexStart + i * 12, true),
            b = view.getUint32(indexStart + i * 12 + 4, true),
            c = view.getUint32(indexStart + i * 12 + 8, true);
        if (
            a >= lod.vertices ||
            b >= lod.vertices ||
            c >= lod.vertices ||
            a === b ||
            b === c ||
            a === c
        )
            throw new Error('Invalid world-model triangle indices.');
        // Validate the source, not sub-pixel triangles rounded by the scene's Float32 meter conversion.
        const ux = coordinate(b, 0) - coordinate(a, 0),
            uy = coordinate(b, 1) - coordinate(a, 1),
            uz = coordinate(b, 2) - coordinate(a, 2);
        const vx = coordinate(c, 0) - coordinate(a, 0),
            vy = coordinate(c, 1) - coordinate(a, 1),
            vz = coordinate(c, 2) - coordinate(a, 2);
        const nx = uy * vz - uz * vy,
            ny = uz * vx - ux * vz,
            nz = ux * vy - uy * vx;
        if (nx === 0 && ny === 0 && nz === 0) throw new Error('Degenerate world-model triangle.');
        if (lod.cubeSizeCm && Number(nx !== 0) + Number(ny !== 0) + Number(nz !== 0) !== 1)
            throw new Error('Cube faces must remain axis-aligned.');
        // Vertical block faces already have identical UVs along each vertical edge.
        const group = textureBlockSides && flag === 0 && nz === 0 ? 4 : flag;
        surfaceGroups[i] = group;
        counts[group] += 3;
    }
    const starts = [0];
    for (let i = 1; i < counts.length; i++) starts[i] = starts[i - 1] + counts[i - 1];
    const cursors = starts.slice();
    const indices = new Uint32Array(lod.triangles * 3);
    for (let i = 0; i < lod.triangles; i++) {
        const a = view.getUint32(indexStart + i * 12, true),
            b = view.getUint32(indexStart + i * 12 + 4, true),
            c = view.getUint32(indexStart + i * 12 + 8, true);
        const group = surfaceGroups[i];
        // Swapping the Unreal Y/Z axes reverses handedness.
        const offset = cursors[group];
        indices[offset] = a;
        indices[offset + 1] = c;
        indices[offset + 2] = b;
        cursors[group] += 3;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    if (lod.morph) {
        const coarse = new Float32Array(lod.vertices * 3);
        const transitions = new Float32Array(lod.vertices * 2);
        const start = flagStart + lod.triangles;
        for (let i = 0; i < lod.vertices; i++) {
            const x = view.getFloat32(start + i * 12, true);
            const y = view.getFloat32(start + i * 12 + 4, true);
            const z = view.getFloat32(start + i * 12 + 8, true);
            if (
                ![x, y, z].every(Number.isFinite) ||
                x < box.minX - 0.1 ||
                x > box.maxX + 0.1 ||
                y < box.minY - 0.1 ||
                y > box.maxY + 0.1 ||
                z < box.minZ - 0.1 ||
                z > box.maxZ + 0.1
            )
                throw new Error('Parent correspondence outside patch bounds.');
            coarse.set([(x - centerX) / 100, z / 100, (y - centerY) / 100], i * 3);
            transitions.set([-1e9, 1], i * 2);
        }
        geometry.setAttribute('worldCoarsePosition', new THREE.BufferAttribute(coarse, 3));
        geometry.setAttribute(
            'worldPatchTransition',
            new THREE.BufferAttribute(transitions, 2).setUsage(THREE.DynamicDrawUsage),
        );
    }
    for (let flag = 0; flag < counts.length; flag++)
        if (counts[flag]) geometry.addGroup(starts[flag], counts[flag], flag);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    if (lod.morph)
        geometry.boundingBox!.union(
            new THREE.Box3().setFromBufferAttribute(
                geometry.getAttribute('worldCoarsePosition') as THREE.BufferAttribute,
            ),
        );
    geometry.computeBoundingSphere();
    if (lod.morph) geometry.boundingBox!.getBoundingSphere(geometry.boundingSphere!);
    return geometry;
}

export interface WorldSelection {
    tile: WorldTile;
    lod: number;
}
export function selectWorldTiles(
    manifest: WorldModelManifest,
    camera: MapCamera,
    target: THREE.Vector3,
    viewportHeight: number,
    exaggeration: number,
    centerX: number,
    centerY: number,
    triangleBudget = WORLD_TRIANGLES,
    byteBudget = WORLD_RESIDENT_BYTES,
): WorldSelection[] {
    camera.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const candidates = manifest.tiles
        .map((tile) => {
            const b = tile.bounds;
            const box = new THREE.Box3(
                new THREE.Vector3(
                    (b.minX - centerX) / 100,
                    (b.minZ / 100) * exaggeration,
                    (b.minY - centerY) / 100,
                ),
                new THREE.Vector3(
                    (b.maxX - centerX) / 100,
                    (b.maxZ / 100) * exaggeration,
                    (b.maxY - centerY) / 100,
                ),
            );
            const distance = Math.max(1, box.distanceToPoint(camera.position));
            let wanted = 0;
            for (let i = tile.lods.length - 1; i >= 0; i--)
                if (
                    ((tile.lods[i].maxErrorCm / 100) * Math.max(1, exaggeration)) /
                        worldUnitsPerPixel(camera, viewportHeight, distance) <=
                    2
                ) {
                    wanted = i;
                    break;
                }
            return { tile, box, wanted, distance, targetDistance: box.distanceToPoint(target) };
        })
        .filter((c) => frustum.intersectsBox(c.box.clone().expandByScalar(20)))
        .sort(
            (a, b) =>
                a.distance - b.distance ||
                a.targetDistance - b.targetDistance ||
                a.tile.id.localeCompare(b.tile.id),
        );
    let triangles = 0,
        bytes = 0;
    const selected: { tile: WorldTile; lod: number; wanted: number }[] = [];
    for (const candidate of candidates) {
        const lod = candidate.tile.lods.length - 1,
            descriptor = candidate.tile.lods[lod];
        if (
            triangles + descriptor.triangles > triangleBudget ||
            bytes + worldGeometryBytes(descriptor) > byteBudget
        )
            continue;
        selected.push({ tile: candidate.tile, lod, wanted: candidate.wanted });
        triangles += descriptor.triangles;
        bytes += worldGeometryBytes(descriptor);
    }
    for (const item of selected) {
        const old = item.tile.lods[item.lod];
        for (let lod = item.wanted; lod < item.lod; lod++) {
            const next = item.tile.lods[lod];
            const deltaBytes = worldGeometryBytes(next) - worldGeometryBytes(old);
            if (
                triangles + next.triangles - old.triangles <= triangleBudget &&
                bytes + deltaBytes <= byteBudget
            ) {
                triangles += next.triangles - old.triangles;
                bytes += deltaBytes;
                item.lod = lod;
                break;
            }
        }
    }
    return selected.map(({ tile, lod }) => ({ tile, lod }));
}

type SurfaceMaterial = THREE.MeshPhongMaterial | THREE.MeshBasicMaterial;
interface Appearance {
    exaggeration: number;
    opacity: number;
    lighting: boolean;
    wireframe: boolean;
    slopes: boolean;
    cutHeightCm: number;
}
interface Context {
    url: string;
    mapKey: string;
    centerX: number;
    centerY: number;
    mapBounds: Pick<CoordinateSystem, 'minX' | 'minY' | 'maxX' | 'maxY'>;
    texture?: THREE.Texture;
}
export interface WorldModelStatus {
    text: string;
    retry?: boolean;
    manifest?: WorldModelManifest;
}
interface Resident {
    tile: WorldTile;
    lod: number;
    mesh: THREE.Mesh<THREE.BufferGeometry, SurfaceMaterial[]>;
    wire: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
}

function colorCoveredSurface(material: SurfaceMaterial, texel: THREE.Vector2): void {
    Object.assign(material, { extensions: { derivatives: true } });
    material.onBeforeCompile = (shader) => {
        shader.uniforms.worldColorTexel = { value: texel };
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 worldColorPosition;')
            .replace(
                '#include <begin_vertex>',
                '#include <begin_vertex>\nworldColorPosition = position;',
            );
        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                `#include <common>
uniform vec2 worldColorTexel;
varying vec3 worldColorPosition;`,
            )
            .replace(
                '#include <map_fragment>',
                `
#ifdef USE_MAP
    vec4 nearbyColor = vec4(0.0);
    vec2 centerUv = clamp((floor(vUv / worldColorTexel) + 0.5) * worldColorTexel,
        worldColorTexel * 0.5, vec2(1.0) - worldColorTexel * 0.5);
    for (int y = -2; y <= 2; y++) {
        for (int x = -2; x <= 2; x++) {
            vec2 sampleUv = clamp(centerUv + vec2(float(x), float(y)) * worldColorTexel,
                worldColorTexel * 0.5, vec2(1.0) - worldColorTexel * 0.5);
            nearbyColor += mapTexelToLinear(texture2D(map, sampleUv));
        }
    }
    vec3 faceCross = cross(dFdx(worldColorPosition), dFdy(worldColorPosition));
    float upward = (gl_FrontFacing ? 1.0 : -1.0) *
        faceCross.y / max(length(faceCross), 0.0000001);
    float surfaceLightness = 0.60 + 0.25 * clamp(upward, -1.0, 1.0);
    diffuseColor *= vec4(nearbyColor.rgb / 25.0 * surfaceLightness, nearbyColor.a / 25.0);
#endif`,
            );
    };
    material.customProgramCacheKey = () => 'world-nearby-color-v3';
}

export class WorldModelLayer {
    readonly group = new THREE.Group();
    readonly clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e9);
    private manifest?: WorldModelManifest;
    private context?: Context;
    private controller?: AbortController;
    private revision = 0;
    private resident = new Map<string, Resident>();
    private pending = new Map<string, { lod: number; controller: AbortController }>();
    private failed = new Map<string, string>();
    private desired: WorldSelection[] = [];
    private progressive?: ProgressiveWorld;
    private morphTime = { value: 0 };
    private cubeSizeFactor = 4;
    private materials: SurfaceMaterial[] = [];
    private wireMaterial?: THREE.MeshBasicMaterial;
    private appearance: Appearance = {
        exaggeration: 1,
        opacity: 1,
        lighting: true,
        wireframe: false,
        slopes: false,
        cutHeightCm: 1e11,
    };
    private request: typeof fetch;
    constructor(
        private status: (status: WorldModelStatus) => void,
        request: typeof fetch = fetch,
    ) {
        this.request = request.bind(globalThis);
    }
    get meshes(): THREE.Mesh[] {
        if (this.progressive) return this.progressive.meshes;
        return [...this.resident.values()].map((item) => item.mesh);
    }
    get active(): boolean {
        return !!this.context;
    }
    get selectionIntervalMs(): number {
        return this.progressive ? 50 : 250;
    }
    clear(): void {
        this.revision++;
        this.controller?.abort();
        this.controller = undefined;
        for (const request of this.pending.values()) request.controller.abort();
        this.pending.clear();
        this.progressive?.clear();
        this.progressive = undefined;
        for (const item of this.resident.values()) item.mesh.geometry.dispose();
        this.resident.clear();
        this.group.clear();
        this.materials.forEach((material) => material.dispose());
        this.materials = [];
        this.wireMaterial?.dispose();
        this.wireMaterial = undefined;
        this.clipPlane.constant = 1e9;
        this.context = undefined;
        this.manifest = undefined;
        this.desired = [];
        this.failed.clear();
    }
    async enable(context: Context): Promise<void> {
        this.clear();
        this.context = context;
        const revision = this.revision;
        const controller = (this.controller = new AbortController());
        this.status({ text: 'Loading continuous world-model metadata…' });
        try {
            const bytes = await boundedResponse(
                await this.request(context.url, { signal: controller.signal, cache: 'no-store' }),
                128 * 1024 * 1024,
                controller.signal,
                'World model',
            );
            controller.signal.throwIfAborted();
            const manifest = validateWorldModel(
                JSON.parse(new TextDecoder().decode(bytes)),
                context.mapKey,
            );
            if (revision !== this.revision) return;
            this.manifest = manifest;
            this.makeMaterials();
            this.setAppearance(this.appearance);
            if (manifest.roots) {
                this.progressive = new ProgressiveWorld(
                    manifest,
                    context,
                    this.request,
                    this.group,
                    (geometry) => {
                        const mesh = new THREE.Mesh(geometry, this.materials);
                        const wire = new THREE.Mesh(geometry, this.wireMaterial!);
                        wire.raycast = () => undefined;
                        wire.visible = this.appearance.wireframe;
                        wire.renderOrder = 1;
                        mesh.add(wire);
                        return mesh;
                    },
                    this.morphTime,
                    (status) => this.status({ ...status, manifest }),
                );
                this.progressive.setCubeSizeFactor(this.cubeSizeFactor);
                this.progressive.start();
                return;
            }
            this.emit();
        } catch (error) {
            if (revision !== this.revision || controller.signal.aborted) return;
            this.clear();
            this.context = context;
            this.status({
                text: `World model failed: ${error instanceof Error ? error.message : String(error)}. No geometry loaded; retry available.`,
                retry: true,
            });
        }
    }
    setAppearance(appearance: Appearance): void {
        const relight = appearance.lighting !== this.appearance.lighting;
        this.appearance = { ...appearance };
        if (relight && this.context && this.manifest) this.makeMaterials();
        this.group.scale.y = appearance.exaggeration;
        this.clipPlane.constant = this.manifest
            ? (appearance.cutHeightCm / 100) * appearance.exaggeration
            : 1e9;
        for (let flag = 0; flag < this.materials.length; flag++) {
            const material = this.materials[flag];
            const mapped = !!(flag & 1) || flag === 4,
                walkable = !!(flag & 2);
            material.color.set(
                appearance.slopes && walkable
                    ? '#3edc65'
                    : this.context?.texture
                      ? '#ffffff'
                      : '#394149',
            );
            material.opacity = mapped ? appearance.opacity : 1;
            material.transparent = material.opacity < 1;
            material.polygonOffset = appearance.wireframe;
            material.polygonOffsetFactor = 1;
            material.polygonOffsetUnits = 1;
            material.needsUpdate = true;
        }
        for (const item of this.resident.values()) item.wire.visible = appearance.wireframe;
        for (const mesh of this.progressive?.allMeshes ?? [])
            for (const wire of mesh.children) wire.visible = appearance.wireframe;
    }
    animate(now: number): void {
        this.morphTime.value = now / 1000;
        this.progressive?.animate();
    }
    update(camera: MapCamera, target: THREE.Vector3, height: number): void {
        const m = this.manifest,
            c = this.context;
        if (!m || !c) return;
        if (this.progressive) {
            this.progressive.update(camera, height, this.appearance.exaggeration, target);
            return;
        }
        this.desired = selectWorldTiles(
            m,
            camera,
            target,
            height,
            this.appearance.exaggeration,
            c.centerX,
            c.centerY,
        );
        const wanted = new Map(this.desired.map((item) => [item.tile.id, item.lod]));
        for (const [id, item] of this.resident)
            if (!wanted.has(id)) {
                this.group.remove(item.mesh);
                item.mesh.geometry.dispose();
                this.resident.delete(id);
            }
        for (const [id, request] of this.pending)
            if (wanted.get(id) !== request.lod) {
                request.controller.abort();
                this.pending.delete(id);
            }
        for (const id of this.failed.keys()) if (!wanted.has(id)) this.failed.delete(id);
        this.pump();
        this.emit();
    }
    setCubeSizeFactor(factor: number): void {
        if (![1, 2, 4, 8, 16, 32, 64].includes(factor)) throw new Error('Invalid far cube size factor.');
        this.cubeSizeFactor = factor;
        this.progressive?.setCubeSizeFactor(factor);
    }
    retry(): void {
        if (this.progressive) {
            this.progressive.retry();
            return;
        }
        if (!this.manifest && this.context) {
            void this.enable(this.context);
            return;
        }
        this.failed.clear();
        this.pump();
    }
    private makeMaterials(): void {
        const context = this.context;
        if (!context) throw new Error('World-model material context is missing.');
        const { mapBounds: c, centerX, centerY } = context;
        const clippingPlanes = [
            this.clipPlane,
            new THREE.Plane(new THREE.Vector3(1, 0, 0), (centerX - c.minX) / 100),
            new THREE.Plane(new THREE.Vector3(-1, 0, 0), (c.maxX - centerX) / 100),
            new THREE.Plane(new THREE.Vector3(0, 0, 1), (centerY - c.minY) / 100),
            new THREE.Plane(new THREE.Vector3(0, 0, -1), (c.maxY - centerY) / 100),
        ];
        const old = this.materials;
        const blockSides = this.manifest?.statistics.representation === 'blocks';
        const image = context.texture ? object(context.texture.image) : undefined;
        const texel = image
            ? new THREE.Vector2(
                  1 / number(image.width, 1, 100_000),
                  1 / number(image.height, 1, 100_000),
              )
            : undefined;
        this.materials = Array.from({ length: blockSides ? 5 : 4 }, (_, flag) => {
            const common = {
                map: context.texture ?? null,
                side: THREE.DoubleSide,
                clippingPlanes,
            };
            const material = this.appearance.lighting
                ? new THREE.MeshPhongMaterial({ ...common, flatShading: true, specular: '#000000' })
                : new THREE.MeshBasicMaterial(common);
            if (!(flag & 1) && texel) colorCoveredSurface(material, texel);
            return material;
        });
        for (const item of this.resident.values()) item.mesh.material = this.materials;
        for (const mesh of this.progressive?.allMeshes ?? []) mesh.material = this.materials;
        old.forEach((material) => material.dispose());
        if (!this.wireMaterial)
            this.wireMaterial = new THREE.MeshBasicMaterial({
                color: '#15222d',
                wireframe: true,
                transparent: true,
                opacity: 0.35,
                depthWrite: false,
                clippingPlanes,
            });
        if (this.manifest?.roots && this.manifest.statistics.hierarchyVersion !== 3) {
            for (const material of [...this.materials, this.wireMaterial])
                attachWorldMorph(material, this.morphTime, c, centerX, centerY);
        }
    }
    private pump(): void {
        if (!this.manifest || !this.context) return;
        for (const selection of this.desired) {
            if (this.pending.size >= 2) break;
            const id = selection.tile.id;
            if (
                this.resident.get(id)?.lod === selection.lod ||
                this.pending.has(id) ||
                this.failed.has(id)
            )
                continue;
            const controller = new AbortController();
            const request = { lod: selection.lod, controller };
            const revision = this.revision,
                context = this.context;
            const descriptor = selection.tile.lods[selection.lod];
            let triangles = 0,
                bytes = 0;
            for (const item of this.resident.values()) {
                const lod = item.tile.lods[item.lod];
                triangles += lod.triangles;
                bytes += worldGeometryBytes(lod);
            }
            const reservations = new Map(this.pending);
            reservations.set(id, request);
            for (const [pendingId, pending] of reservations) {
                const tile = this.manifest.tiles.find((tile) => tile.id === pendingId)!;
                const next = tile.lods[pending.lod],
                    old = this.resident.get(pendingId);
                const previous = old ? old.tile.lods[old.lod] : undefined;
                triangles += Math.max(0, next.triangles - (previous?.triangles ?? 0));
                bytes += Math.max(
                    0,
                    worldGeometryBytes(next) - (previous ? worldGeometryBytes(previous) : 0),
                );
            }
            if (triangles > WORLD_TRIANGLES || bytes > WORLD_RESIDENT_BYTES) continue;
            this.pending.set(id, request);
            void (async () => {
                try {
                    const bytes = await boundedResponse(
                        await this.request(new URL(descriptor.url, context.url), {
                            signal: controller.signal,
                        }),
                        worldBinaryBytes(descriptor),
                        controller.signal,
                        'World-model tile',
                    );
                    controller.signal.throwIfAborted();
                    if (revision !== this.revision || this.pending.get(id) !== request) return;
                    const geometry = worldGeometry(
                        bytes,
                        descriptor,
                        selection.tile.bounds,
                        context.centerX,
                        context.centerY,
                        context.mapBounds,
                        this.manifest?.statistics.representation === 'blocks',
                    );
                    const old = this.resident.get(id);
                    if (old) {
                        this.group.remove(old.mesh);
                        old.mesh.geometry.dispose();
                    }
                    const mesh = new THREE.Mesh(geometry, this.materials);
                    const wire = new THREE.Mesh(geometry, this.wireMaterial!);
                    wire.visible = this.appearance.wireframe;
                    wire.renderOrder = 1;
                    mesh.add(wire);
                    this.group.add(mesh);
                    this.resident.set(id, { tile: selection.tile, lod: selection.lod, mesh, wire });
                } catch (error) {
                    if (revision === this.revision && !controller.signal.aborted)
                        this.failed.set(id, error instanceof Error ? error.message : String(error));
                } finally {
                    if (this.pending.get(id) === request) this.pending.delete(id);
                    if (revision === this.revision) {
                        this.emit();
                        this.pump();
                    }
                }
            })();
        }
    }
    private emit(): void {
        if (!this.manifest) return;
        const triangles = [...this.resident.values()].reduce(
            (sum, item) => sum + item.tile.lods[item.lod].triangles,
            0,
        );
        const error = this.failed.values().next().value;
        this.status({
            manifest: this.manifest,
            retry: !!error,
            text:
                `Continuous skin: ${this.resident.size.toLocaleString()} / ${this.manifest.tiles.length.toLocaleString()} tiles resident, ${triangles.toLocaleString()} triangles. ` +
                'Camera-selected 3D detail; unloaded areas remain empty.' +
                (this.pending.size ? ' Loading…' : '') +
                (error
                    ? ` Tile failed: ${error}. Previous tile retained if available; otherwise this area remains empty.`
                    : ''),
        });
    }
}
