import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshJson } from '../src/metadata.js';

test('discovery metadata bypasses old cached exports and preserves newly published fields', async () => {
    const originalFetch = globalThis.fetch;
    const signal = new AbortController().signal;
    const published = { version: 1, walkability: { url: 'walkable.json' } };
    try {
        globalThis.fetch = async (_url, init) => {
            assert.equal(init?.signal, signal);
            return new Response(
                JSON.stringify(init?.cache === 'no-store' ? published : { version: 1 }),
            );
        };
        assert.deepEqual(await freshJson('https://example.test/terrain.json', signal), published);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('fresh metadata HTTP failures remain explicit', async () => {
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => new Response('', { status: 503 });
        await assert.rejects(
            freshJson('https://example.test/terrain.json', new AbortController().signal),
            /terrain.json: HTTP 503/,
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});
