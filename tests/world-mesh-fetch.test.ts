import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { worldMeshBytes } from '../src/world-mesh-fetch.js';
import type { WorldLod } from '../src/world-model.js';

const decoded = new Uint8Array(65);
const compressed = gzipSync(decoded);
const descriptor: WorldLod = {
    url: 'packed.awmb',
    vertices: 3,
    triangles: 1,
    maxErrorCm: 100,
    byteOffset: 8,
    byteLength: compressed.length,
};
const url = new URL('https://test.invalid/packed.awmb');
const headers = { 'Content-Range': `bytes 8-${7 + compressed.length}/${8 + compressed.length}` };

test('bundle transport fetches and decompresses exactly the indexed member, not the whole blob', async () => {
    const request: typeof fetch = async (_, options) => {
        assert.equal(
            new Headers(options?.headers).get('Range'),
            `bytes=8-${7 + compressed.length}`,
        );
        return new Response(compressed, { status: 206, headers });
    };
    const result = await worldMeshBytes(request, url, descriptor, new AbortController().signal);
    assert.deepEqual(new Uint8Array(result), decoded);
});

test('range transport rejects ignored ranges, mismatched offsets, encoded containers and truncated members', async () => {
    for (const response of [
        new Response(compressed, { status: 200 }),
        new Response(compressed, { status: 206, headers: { 'Content-Range': 'bytes 0-1/100' } }),
        new Response(compressed, {
            status: 206,
            headers: { ...headers, 'Content-Encoding': 'gzip' },
        }),
        new Response(compressed.subarray(1), { status: 206, headers }),
        new Response(gzipSync(new Uint8Array(66)), { status: 206, headers }),
    ])
        await assert.rejects(
            worldMeshBytes(async () => response, url, descriptor, new AbortController().signal),
        );
});
