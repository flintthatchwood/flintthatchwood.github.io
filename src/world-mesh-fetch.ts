import { boundedResponse } from './bounded-response.js';
import { worldBinaryBytes, type WorldLod } from './world-model.js';

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
