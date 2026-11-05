import { boundedResponse } from './bounded-response.js';
import { WORLD_TILE_BYTES, worldBinaryBytes, type WorldLod } from './world-model.js';

export function cubeMeshCounts(bytes: ArrayBuffer): Pick<WorldLod, 'vertices' | 'triangles'> {
    if (bytes.byteLength < 16) throw new Error('Truncated implicit cube header.');
    const view = new DataView(bytes), vertices = view.getUint32(4, true), triangles = view.getUint32(8, true);
    if (view.getUint32(0, true) !== 0x314d5741 || view.getUint32(12, true) !== 0 ||
        (triangles === 0 ? vertices !== 0 : vertices < 3) ||
        bytes.byteLength !== 16 + vertices * 12 + triangles * 13 || bytes.byteLength > WORLD_TILE_BYTES)
        throw new Error('Invalid implicit cube counts or decoded length.');
    return { vertices, triangles };
}

export async function implicitMeshBytes(request: typeof fetch, url: string, signal: AbortSignal): Promise<ArrayBuffer> {
    const response = await request(url, { signal });
    if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error(`Implicit cube: HTTP ${response.status}; a complete chunk is required, including empty chunks.`);
    }
    const bytes = await boundedResponse(response, WORLD_TILE_BYTES, signal, 'Implicit cube');
    cubeMeshCounts(bytes);
    return bytes;
}

export async function worldMeshBytes(
    request: typeof fetch,
    url: URL,
    lod: WorldLod,
    signal: AbortSignal,
): Promise<ArrayBuffer> {
    const ranged = lod.byteOffset !== undefined && lod.byteLength !== undefined;
    const end = ranged ? lod.byteOffset! + lod.byteLength! - 1 : 0;
    const response = await request(url, {
        signal,
        ...(ranged ? { headers: { Range: `bytes=${lod.byteOffset}-${end}` } } : {}),
    });
    if (!ranged)
        return boundedResponse(response, worldBinaryBytes(lod), signal, 'Progressive patch');
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
    if (
        response.status !== 206 ||
        !match ||
        Number(match[1]) !== lod.byteOffset ||
        Number(match[2]) !== end ||
        !Number.isSafeInteger(Number(match[3])) ||
        Number(match[3]) <= end ||
        response.headers.has('Content-Encoding')
    ) {
        await response.body?.cancel();
        throw new Error('Terrain bundle requires an exact, unencoded HTTP byte-range response.');
    }
    const compressed = await boundedResponse(
        response,
        lod.byteLength!,
        signal,
        'Terrain bundle range',
    );
    if (compressed.byteLength !== lod.byteLength)
        throw new Error('Truncated terrain bundle range.');
    if (typeof DecompressionStream === 'undefined')
        throw new Error('Terrain bundles require gzip stream decompression support.');
    const decoded = await boundedResponse(
        new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))),
        worldBinaryBytes(lod),
        signal,
        'Terrain bundle chunk',
    );
    if (decoded.byteLength !== worldBinaryBytes(lod))
        throw new Error('Terrain chunk decoded length does not match its descriptor.');
    return decoded;
}
