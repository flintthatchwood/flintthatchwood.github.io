import type { WorldBounds, WorldModelManifest, WorldTile } from './world-model.js';

export interface CubeGrid {
    meshHash: string;
    processorVersion: string;
    maxLevel: number;
    blobRoot: string;
}

export function cubeGridCoordinates(id: string): [number, number, number, number] {
    const match = /^c(\d+)_(-?\d+)_(-?\d+)_(-?\d+)$/.exec(id);
    if (!match) throw new Error('Invalid implicit cube ID.');
    const [level, x, y, z] = match.slice(1).map(Number);
    if (
        ![level, x, y, z].every(Number.isSafeInteger) ||
        level > 6 ||
        id !== `c${level}_${x}_${y}_${z}`
    )
        throw new Error('Noncanonical implicit cube ID.');
    return [level, x, y, z];
}

function node(
    manifest: WorldModelManifest,
    level: number,
    x: number,
    y: number,
    z: number,
): WorldTile | undefined {
    const span = manifest.tileSizeCm * 2 ** level,
        b = manifest.bounds;
    const box: WorldBounds = {
        minX: Math.max(b.minX, x * span),
        maxX: Math.min(b.maxX, (x + 1) * span),
        minY: Math.max(b.minY, y * span),
        maxY: Math.min(b.maxY, (y + 1) * span),
        minZ: Math.max(b.minZ, z * span),
        maxZ: Math.min(b.maxZ, (z + 1) * span),
    };
    if (box.minX >= box.maxX || box.minY >= box.maxY || box.minZ >= box.maxZ) return;
    const size = manifest.cellSizeCm * 2 ** level;
    return {
        id: `c${level}_${x}_${y}_${z}`,
        bounds: box,
        lods: [
            {
                url: '',
                vertices: 0,
                triangles: 0,
                maxErrorCm: size * Math.sqrt(3),
                cubeSizeCm: size,
                discovered: false,
            },
        ],
    };
}

export function cubeGridChildren(manifest: WorldModelManifest, parent: WorldTile): WorldTile[] {
    const [level, x, y, z] = cubeGridCoordinates(parent.id);
    if (!level) return [];
    const children: WorldTile[] = [];
    for (let dz = 0; dz < 2; dz++)
        for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) {
                const child = node(manifest, level - 1, x * 2 + dx, y * 2 + dy, z * 2 + dz);
                if (child) children.push(child);
            }
    return children;
}

export function cubeGridRoots(manifest: WorldModelManifest): WorldTile[] {
    const level = manifest.grid!.maxLevel,
        span = manifest.tileSizeCm * 2 ** level,
        b = manifest.bounds;
    const roots: WorldTile[] = [];
    const count = (size: number) =>
        [b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ].reduce(
            (product, extent) => product * (Math.ceil(extent / size) + 1),
            1,
        );
    if (count(span) > 512 || count(manifest.tileSizeCm) > 2_000_000)
        throw new Error('Implicit cube grid exceeds supported coverage.');
    for (let z = Math.floor(b.minZ / span); z < Math.ceil(b.maxZ / span); z++)
        for (let y = Math.floor(b.minY / span); y < Math.ceil(b.maxY / span); y++)
            for (let x = Math.floor(b.minX / span); x < Math.ceil(b.maxX / span); x++)
                roots.push(node(manifest, level, x, y, z)!);
    return roots;
}

export async function cubeGridUrl(
    grid: CubeGrid,
    id: string,
    manifestUrl: string,
): Promise<string> {
    cubeGridCoordinates(id);
    const input = new TextEncoder().encode(`${grid.meshHash}\n${grid.processorVersion}\n${id}`);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    const name = [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('') + '.awm.gz';
    return new URL(name, new URL(grid.blobRoot, manifestUrl)).href;
}
