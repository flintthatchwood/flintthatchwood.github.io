import { boundedResponse } from './bounded-response.js';
import type { WorldBounds } from './world-model.js';

type Point = { x: number; y: number; z: number };
export interface VoxelSelection {
    bounds: WorldBounds;
    sizeCm: number;
    tuple: string;
}
export interface VoxelReferenceTile {
    bounds: WorldBounds;
    url: string;
    decodedBytes: number;
}
export interface VoxelReference {
    version: 1;
    cellSizeCm: number;
    tiles: VoxelReferenceTile[];
}
const MAX_BYTES = 32 * 1024 * 1024;
const axes = ['X', 'Y', 'Z'] as const;
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid voxel inspection object.');
    return value as Record<string, unknown>;
}
function numeric(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error('Invalid voxel inspection number.');
    return value;
}
export function voxelAt(
    point: Point,
    normal: Point,
    grid: WorldBounds,
    sizeCm: number,
): VoxelSelection {
    if (![100, 200, 400, 800, 1600, 3200, 6400].includes(sizeCm))
        throw new Error('Unsupported voxel size.');
    const b = { ...grid };
    for (const axis of axes) {
        const key = axis.toLowerCase() as keyof Point;
        // Face hits belong to the solid cell inward of the outward normal.
        const p = numeric(point[key]) - numeric(normal[key]) * 0.5;
        const min = numeric(grid[`min${axis}`]),
            max = numeric(grid[`max${axis}`]);
        if (min >= max) throw new Error('Invalid voxel grid bounds.');
        const low = min + Math.floor((p - min) / sizeCm) * sizeCm;
        if (low < min || low >= max) throw new Error('Picked voxel is outside the occupancy grid.');
        b[`min${axis}`] = low;
        b[`max${axis}`] = Math.min(max, low + sizeCm);
    }
    const metres = (n: number): string => String(Number((n / 100).toFixed(6)));
    return {
        bounds: b,
        sizeCm,
        tuple: `(${[b.minX, b.minY, b.minZ, sizeCm].map(metres).join(',')})`,
    };
}
export function validateVoxelReference(
    value: unknown,
    world: WorldBounds,
    tileSize: number,
): VoxelReference {
    const v = object(value),
        cell = numeric(v.cellSizeCm);
    const columns = Math.ceil((world.maxX - world.minX) / tileSize);
    const rows = Math.ceil((world.maxY - world.minY) / tileSize);
    if (
        v.version !== 1 ||
        ![100, 200, 400].includes(cell) ||
        !Array.isArray(v.tiles) ||
        v.tiles.length !== columns * rows ||
        v.tiles.length > 262144
    )
        throw new Error('Incomplete or unsupported voxel inspection grid.');
    const seen = new Set<string>();
    const tiles = v.tiles.map((raw): VoxelReferenceTile => {
        const t = object(raw),
            source = object(t.bounds);
        const b: WorldBounds = {
            minX: numeric(source.minX),
            minY: numeric(source.minY),
            minZ: numeric(source.minZ),
            maxX: numeric(source.maxX),
            maxY: numeric(source.maxY),
            maxZ: numeric(source.maxZ),
        };
        const x = (b.minX - world.minX) / tileSize,
            y = (b.minY - world.minY) / tileSize;
        const key = `${x},${y}`,
            bytes = numeric(t.decodedBytes);
        if (
            !Number.isInteger(x) ||
            !Number.isInteger(y) ||
            x < 0 ||
            y < 0 ||
            x >= columns ||
            y >= rows ||
            seen.has(key) ||
            b.maxX !== Math.min(world.maxX, b.minX + tileSize) ||
            b.maxY !== Math.min(world.maxY, b.minY + tileSize) ||
            b.minZ !== world.minZ ||
            b.maxZ !== world.maxZ ||
            b.minZ >= b.maxZ ||
            !Number.isInteger(bytes) ||
            bytes < 12 ||
            bytes > MAX_BYTES ||
            typeof t.url !== 'string' ||
            /[\s\\?#%]/.test(t.url) ||
            t.url.split('/').includes('..') ||
            !/^(?:[a-z0-9_./-]+\.air\.gz|https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/[a-z0-9-]+\/managed\/v1\/[0-9a-f]{64}\.air\.gz)$/.test(
                t.url,
            ) ||
            t.url.startsWith('/')
        )
            throw new Error('Invalid voxel inspection tile or URL.');
        seen.add(key);
        return { bounds: b, url: t.url, decodedBytes: bytes };
    });
    return { version: 1, cellSizeCm: cell, tiles };
}
export interface VoxelOccupancy {
    view: DataView;
    offsets: Uint32Array;
    columns: number;
    rows: number;
}
export function readVoxelOccupancy(
    buffer: ArrayBuffer,
    tile: VoxelReferenceTile,
    cell: number,
): VoxelOccupancy {
    if (
        buffer.byteLength !== tile.decodedBytes ||
        buffer.byteLength < 12 ||
        buffer.byteLength > MAX_BYTES
    )
        throw new Error('Voxel inspection length differs from its manifest.');
    const view = new DataView(buffer);
    const columns = view.getInt32(0, true),
        rows = view.getInt32(4, true);
    if (
        columns !== Math.ceil((tile.bounds.maxX - tile.bounds.minX) / cell) ||
        rows !== Math.ceil((tile.bounds.maxY - tile.bounds.minY) / cell) ||
        columns < 1 ||
        rows < 1 ||
        columns * rows > 262144
    )
        throw new Error('Invalid voxel inspection dimensions.');
    const levels = Math.ceil((tile.bounds.maxZ - tile.bounds.minZ) / cell);
    const offsets = new Uint32Array(columns * rows);
    let offset = 8;
    for (let i = 0; i < offsets.length; i++) {
        if (offset + 4 > buffer.byteLength) throw new Error('Truncated voxel inspection column.');
        offsets[i] = offset;
        const count = view.getInt32(offset, true);
        offset += 4;
        if (count < 0 || count > levels || offset + count * 12 > buffer.byteLength)
            throw new Error('Invalid voxel inspection interval count.');
        let previous = 0;
        for (let j = 0; j < count; j++, offset += 12) {
            const low = view.getInt32(offset, true),
                high = view.getInt32(offset + 4, true);
            const component = view.getInt32(offset + 8, true);
            if (
                low < previous ||
                high <= low ||
                high > levels ||
                (component !== 0 && component !== -1)
            )
                throw new Error('Invalid or unnormalized voxel inspection interval.');
            previous = high;
        }
    }
    if (offset !== buffer.byteLength) throw new Error('Trailing voxel inspection data.');
    return { view, offsets, columns, rows };
}
function overlap(a: number, b: number, c: number, d: number): number {
    return Math.max(0, Math.min(b, d) - Math.max(a, c));
}
export function voxelSolidVolume(
    data: VoxelOccupancy,
    tile: VoxelReferenceTile,
    cell: number,
    query: WorldBounds,
): number {
    const b = tile.bounds;
    let solid = 0;
    const lowZ = Math.max(b.minZ, query.minZ),
        highZ = Math.min(b.maxZ, query.maxZ);
    for (
        let y = Math.max(0, Math.floor((query.minY - b.minY) / cell));
        y < Math.min(data.rows, Math.ceil((query.maxY - b.minY) / cell));
        y++
    )
        for (
            let x = Math.max(0, Math.floor((query.minX - b.minX) / cell));
            x < Math.min(data.columns, Math.ceil((query.maxX - b.minX) / cell));
            x++
        ) {
            const area =
                overlap(
                    query.minX,
                    query.maxX,
                    b.minX + x * cell,
                    Math.min(b.maxX, b.minX + (x + 1) * cell),
                ) *
                overlap(
                    query.minY,
                    query.maxY,
                    b.minY + y * cell,
                    Math.min(b.maxY, b.minY + (y + 1) * cell),
                );
            let height = Math.max(0, highZ - lowZ);
            let offset = data.offsets[y * data.columns + x];
            const count = data.view.getInt32(offset, true);
            offset += 4;
            for (let i = 0; i < count; i++, offset += 12)
                height -= overlap(
                    lowZ,
                    highZ,
                    b.minZ + data.view.getInt32(offset, true) * cell,
                    b.minZ + data.view.getInt32(offset + 4, true) * cell,
                );
            solid += area * Math.max(0, height);
        }
    return solid;
}
export class VoxelReferenceReader {
    private cache = new Map<string, VoxelOccupancy>();
    constructor(
        private reference: VoxelReference,
        private url: string,
        private request: typeof fetch = fetch,
    ) {
        this.request = request.bind(globalThis);
    }
    async fill(query: WorldBounds, signal: AbortSignal): Promise<number> {
        const tiles = this.reference.tiles.filter((t) =>
            axes.every(
                (a) =>
                    overlap(
                        query[`min${a}`],
                        query[`max${a}`],
                        t.bounds[`min${a}`],
                        t.bounds[`max${a}`],
                    ) > 0,
            ),
        );
        const volume =
            (query.maxX - query.minX) * (query.maxY - query.minY) * (query.maxZ - query.minZ);
        const covered = tiles.reduce(
            (sum, t) =>
                sum +
                axes.reduce(
                    (v, a) =>
                        v *
                        overlap(
                            query[`min${a}`],
                            query[`max${a}`],
                            t.bounds[`min${a}`],
                            t.bounds[`max${a}`],
                        ),
                    1,
                ),
            0,
        );
        if (
            !Number.isFinite(volume) ||
            !(volume > 0) ||
            Math.abs(covered - volume) > volume * 1e-10
        )
            throw new Error('Voxel is not fully covered by the reference grid.');
        let solid = 0;
        for (const tile of tiles) {
            signal.throwIfAborted();
            let data = this.cache.get(tile.url);
            if (!data) {
                const response = await this.request(new URL(tile.url, this.url), { signal });
                data = readVoxelOccupancy(
                    await boundedResponse(response, tile.decodedBytes, signal, 'Voxel inspection'),
                    tile,
                    this.reference.cellSizeCm,
                );
                signal.throwIfAborted();
                this.cache.set(tile.url, data);
                while (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value!);
            }
            if (
                data.view.byteLength !== tile.decodedBytes ||
                data.columns !==
                    Math.ceil((tile.bounds.maxX - tile.bounds.minX) / this.reference.cellSizeCm) ||
                data.rows !==
                    Math.ceil((tile.bounds.maxY - tile.bounds.minY) / this.reference.cellSizeCm)
            )
                throw new Error('Cached voxel inspection binary does not match this partition.');
            solid += voxelSolidVolume(data, tile, this.reference.cellSizeCm, query);
        }
        return (solid / volume) * 100;
    }
}
