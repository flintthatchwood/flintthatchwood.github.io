import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json } from '../src/metadata.js';

test('immutable metadata uses normal HTTP caching and preserves cancellation and published fields', async () => {
    const originalFetch = globalThis.fetch;
    const signal = new AbortController().signal;
    const published = { version: 1, walkability: { url: 'walkable.json' } };
    try {
        globalThis.fetch = async (_url, init) => {
            assert.equal(init?.signal, signal);
            assert.equal(init?.cache, undefined);
            return new Response(JSON.stringify(published));
        };
        assert.deepEqual(await json('https://example.test/terrain.json', signal), published);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('fresh metadata HTTP failures remain explicit', async () => {
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => new Response('', { status: 503 });
        await assert.rejects(
            json('https://example.test/terrain.json', new AbortController().signal),
            /terrain.json: HTTP 503/,
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});
