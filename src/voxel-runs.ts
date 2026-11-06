import type { WorldBounds } from './world-model.js';

export interface VoxelDescriptor {
    offset: number;
    length: number;
    count: number;
    bundleBytes: number;
    sha256: string;
    faces: number;
}
export interface VoxelMesh {
    bytes: ArrayBuffer;
    vertices: number;
    triangles: number;
    unitFaces: number;
}
export interface VoxelMesher {
    mesh(bytes: ArrayBuffer, bounds: WorldBounds, count: number, signal: AbortSignal): Promise<VoxelMesh>;
    dispose(): void;
}
export function decodeVoxelRuns(bytes: ArrayBuffer, bounds: WorldBounds, expectedCount: number) {
    const data = new DataView(bytes);
    if (bytes.byteLength < 32 || data.getUint32(0, true) !== 0x314c5256)
        throw new Error('Invalid VRL1 voxel-run header.');
    const columns = data.getUint16(4, true), rows = data.getUint16(6, true), levels = data.getUint16(8, true);
    const count = data.getUint32(24, true);
    if (columns < 1 || columns > 128 || rows < 1 || rows > 128 || levels < 1 || levels > 4095 ||
        data.getUint16(10, true) !== 100 || data.getUint32(28, true) !== 0 ||
        count !== expectedCount || bytes.byteLength !== 32 + count * 6 || bytes.byteLength > 32 * 1024 * 1024 ||
        data.getInt32(12, true) !== bounds.minX || data.getInt32(16, true) !== bounds.minY ||
        data.getInt32(20, true) !== bounds.minZ || bounds.maxX - bounds.minX !== columns * 100 ||
        bounds.maxY - bounds.minY !== rows * 100 || bounds.maxZ - bounds.minZ !== levels * 100 ||
        Object.values(bounds).some(v => !Number.isSafeInteger(v) || v % 100 !== 0))
        throw new Error('Voxel runs differ from declared chunk bounds, count or length.');
    const offsets = new Uint32Array(columns * rows + 1);
    let previousColumn = -1, previousHigh = -1;
    for (let i = 0; i < count; i++) {
        const word = data.getUint32(32 + i * 6, true), length = data.getUint16(36 + i * 6, true);
        const x = word & 255, y = word >>> 8 & 255, z = word >>> 16 & 4095;
        const column = y * columns + x;
        if (word >>> 29 || x >= columns || y >= rows || !length || z + length > levels ||
            column < previousColumn || column === previousColumn && z <= previousHigh)
            throw new Error('Unsorted, overlapping, adjacent or out-of-bounds voxel run.');
        offsets[column + 1]++;
        previousColumn = column;
        previousHigh = z + length;
    }
    for (let i = 1; i < offsets.length; i++) offsets[i] += offsets[i - 1];
    return { data, columns, rows, levels, count, offsets };
}

export function meshVoxelRuns(bytes: ArrayBuffer, bounds: WorldBounds, expectedCount: number): VoxelMesh {
    const { data, columns, rows, count, offsets } = decodeVoxelRuns(bytes, bounds, expectedCount);
    const planes = new Map<number, Set<number>>();
    let unitFaces = 0;
    const add = (axis: number, plane: number, positive: boolean, flag: number, u: number, v: number) => {
        if (++unitFaces > 8_000_000) throw new Error('Voxel chunk exceeds the eight-million-face meshing limit.');
        const key = plane | axis << 12 | Number(positive) << 14 | flag << 15;
        let cells = planes.get(key);
        if (!cells) planes.set(key, cells = new Set());
        cells.add(u | v << 12);
    };
    for (let i = 0; i < count; i++) {
        const word = data.getUint32(32 + i * 6, true), length = data.getUint16(36 + i * 6, true);
        const x = word & 255, y = word >>> 8 & 255, low = word >>> 16 & 4095, high = low + length;
        add(2, low, false, 0, x, y);
        add(2, high, true, word >>> 28 & 1, x, y);
        const side = (xx: number, yy: number, axis: number, plane: number, positive: boolean) => {
            let start = low;
            const emit = (end: number) => {
                for (let z = start; z < end; z++)
                    add(axis, plane, positive, 0, axis === 0 ? y : z, axis === 0 ? z : x);
            };
            if (xx >= 0 && xx < columns && yy >= 0 && yy < rows) {
                const column = yy * columns + xx;
                for (let j = offsets[column]; j < offsets[column + 1] && start < high; j++) {
                    const other = data.getUint32(32 + j * 6, true);
                    const a = other >>> 16 & 4095, b = a + data.getUint16(36 + j * 6, true);
                    if (b <= start) continue;
                    if (a >= high) break;
                    emit(Math.min(a, high));
                    start = Math.max(start, b);
                }
            }
            if (start < high) emit(high);
        };
        side(x - 1, y, 0, x, false); side(x + 1, y, 0, x + 1, true);
        side(x, y - 1, 1, y, false); side(x, y + 1, 1, y + 1, true);
    }
    const positions: number[] = [], indices: number[] = [], flags: number[] = [];
    const vertices = new Map<number, number>();
    for (const [key, cells] of [...planes].sort((a, b) => a[0] - b[0])) {
        const plane = key & 4095, axis = key >>> 12 & 3, positive = (key & 16384) !== 0, flag = key >>> 15;
        for (const cell of [...cells].sort((a, b) => a - b)) {
            if (!cells.has(cell)) continue;
            const u = cell & 4095, v = cell >>> 12;
            let width = 1, height = 1;
            while (cells.has(u + width | v << 12)) width++;
            while (true) {
                let complete = true;
                for (let x = 0; x < width; x++)
                    if (!cells.has(u + x | (v + height) << 12)) { complete = false; break; }
                if (!complete) break;
                height++;
            }
            for (let y = 0; y < height; y++)
                for (let x = 0; x < width; x++) cells.delete(u + x | (v + y) << 12);
            const vertex = (uu: number, vv: number) => {
                const xyz = [0, 0, 0];
                xyz[axis] = plane; xyz[(axis + 1) % 3] = uu; xyz[(axis + 2) % 3] = vv;
                const packed = xyz[0] | xyz[1] << 8 | xyz[2] << 16;
                let id = vertices.get(packed);
                if (id === undefined) {
                    id = positions.length / 3;
                    vertices.set(packed, id);
                    positions.push(bounds.minX + xyz[0] * 100, bounds.minY + xyz[1] * 100, bounds.minZ + xyz[2] * 100);
                }
                return id;
            };
            const a = vertex(u, v), b = vertex(u + width, v), c = vertex(u + width, v + height), d = vertex(u, v + height);
            indices.push(...(positive ? [a, b, c, a, c, d] : [a, c, b, a, d, c]));
            flags.push(flag, flag);
            if (16 + positions.length * 4 + indices.length * 4 + flags.length > 32 * 1024 * 1024)
                throw new Error('Generated voxel mesh exceeds the 32 MiB tile limit.');
        }
    }
    const size = 16 + positions.length * 4 + indices.length * 4 + flags.length;
    if (size > 32 * 1024 * 1024) throw new Error('Generated voxel mesh exceeds the 32 MiB tile limit.');
    const mesh = new ArrayBuffer(size), writer = new DataView(mesh);
    [0x314d5741, positions.length / 3, flags.length, 0].forEach((value, i) => writer.setUint32(i * 4, value, true));
    let at = 16;
    for (const value of positions) { writer.setFloat32(at, value, true); at += 4; }
    for (const value of indices) { writer.setUint32(at, value, true); at += 4; }
    for (const value of flags) writer.setUint8(at++, value);
    return { bytes: mesh, vertices: positions.length / 3, triangles: flags.length, unitFaces };
}
