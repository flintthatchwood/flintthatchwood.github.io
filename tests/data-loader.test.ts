import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataLoader, DATA_INDEX_URL } from '../src/data/DataLoader.js';

test('only the site index revalidates; versioned map files use HTTP caching and Blob-relative URLs', async () => {
    const original = globalThis.fetch;
    const requests: { url: string; init?: Parameters<typeof fetch>[1] }[] = [];
    const signal = new AbortController().signal;
    try {
        globalThis.fetch = async (input, init) => {
            const url = String(input);
            requests.push({ url, init });
            if (url === DATA_INDEX_URL)
                return Response.json({
                    version: 1,
                    resourceTypes: [],
                    maps: [{ key: 'Island', name: 'Island', indexUrl: 'maps/island/v1.json' }],
                });
            return Response.json({
                version: 1,
                mapKey: 'Island',
                dataUrl: '../../managed/v1/data.json',
                imageUrl: '../../managed/v1/image.webp',
                terrainUrl: '../../managed/v1/terrain.json',
            });
        };
        const loader = new DataLoader();
        await loader.loadIndex();
        const version = await loader.loadMapVersion('Island', signal);
        assert.equal(requests[0].url, DATA_INDEX_URL);
        assert.equal(requests[0].init?.cache, 'no-cache');
        assert.equal(requests[1].init?.cache, undefined);
        assert.equal(requests[1].init?.signal, signal);
        assert.equal(
            version.dataUrl,
            'https://arkres.blob.core.windows.net/terrain/managed/v1/data.json',
        );
        assert.equal(
            version.imageUrl,
            'https://arkres.blob.core.windows.net/terrain/managed/v1/image.webp',
        );
        assert.equal(
            version.terrainUrl,
            'https://arkres.blob.core.windows.net/terrain/managed/v1/terrain.json',
        );
    } finally {
        globalThis.fetch = original;
    }
});

test('map versions reject wrong identities and invalid links without replacing errors with a success', async () => {
    const original = globalThis.fetch;
    const valid = {
        version: 1,
        mapKey: 'Island',
        dataUrl: 'data.json',
        imageUrl: 'image.webp',
        terrainUrl: null,
    };
    try {
        const loader = new DataLoader();
        globalThis.fetch = async () =>
            Response.json({
                version: 1,
                maps: [{ key: 'Island', name: 'Island', indexUrl: 'map.json' }],
                resourceTypes: [],
            });
        await loader.loadIndex();
        for (const change of [
            { mapKey: 'Other' },
            { dataUrl: '' },
            { imageUrl: null },
            { terrainUrl: 42 },
            { version: 2 },
        ]) {
            globalThis.fetch = async () => Response.json({ ...valid, ...change });
            await assert.rejects(loader.loadMapVersion('Island'), /Invalid map version/);
        }
        globalThis.fetch = async () => Response.json(valid);
        assert.equal((await loader.loadMapVersion('Island')).terrainUrl, null);
        globalThis.fetch = async () => new Response('', { status: 503 });
        await assert.rejects(loader.loadMapVersion('Island'), /HTTP 503/);
        await assert.rejects(loader.loadMapVersion('Missing'), /not found/);
    } finally {
        globalThis.fetch = original;
    }
});

test('site-index failures are explicit', async () => {
    const original = globalThis.fetch;
    try {
        globalThis.fetch = async () => new Response('', { status: 403 });
        await assert.rejects(new DataLoader().loadIndex(), /403/);
        globalThis.fetch = async () => Response.json({ maps: [], resourceTypes: [] });
        await assert.rejects(new DataLoader().loadIndex(), /Invalid site data index/);
    } finally {
        globalThis.fetch = original;
    }
});

test('parent map selects Ocean by default and lazily loads only the selected submap', async () => {
    const original = globalThis.fetch;
    const requests: string[] = [];
    const root = 'https://example.invalid/';
    const submaps = [
        {
            key: 'biomes',
            name: 'Biomes',
            type: 'Layer',
            datasetKey: 'Genesis_WP_Main',
            indexUrl: '../main.json',
        },
        {
            key: 'ocean',
            name: 'Ocean',
            type: 'Layer',
            datasetKey: 'Genesis_WP_Ocean',
            indexUrl: '../ocean.json',
        },
    ];
    try {
        globalThis.fetch = async (input) => {
            const url = String(input);
            requests.push(url);
            if (url === root + 'index.json')
                return Response.json({
                    version: 1,
                    resourceTypes: [],
                    maps: [{ key: 'Genesis_WP', name: 'Genesis 1', indexUrl: 'maps/genesis.json' }],
                });
            if (url === root + 'maps/genesis.json')
                return Response.json({
                    version: 2,
                    mapKey: 'Genesis_WP',
                    defaultSubmap: 'ocean',
                    submaps,
                });
            return Response.json({
                version: 1,
                mapKey: url === root + 'ocean.json' ? 'Genesis_WP_Ocean' : 'Genesis_WP_Main',
                dataUrl: 'data.json',
                imageUrl: 'image.png',
                terrainUrl: null,
            });
        };
        const loader = new DataLoader(root + 'index.json');
        const index = await loader.loadMapIndex('Genesis_WP');
        assert.equal(index.defaultSubmap, 'ocean');
        assert.equal(requests.length, 2);
        assert.equal((await loader.loadMapVersion('Genesis_WP')).mapKey, 'Genesis_WP_Ocean');
        assert.equal(requests.length, 3);
        assert.equal(
            (await loader.loadMapVersion('Genesis_WP', undefined, 'biomes')).mapKey,
            'Genesis_WP_Main',
        );
        assert.equal(requests.length, 4);
        await assert.rejects(
            loader.loadMapVersion('Genesis_WP', undefined, 'missing'),
            /Unknown submap/,
        );
        const abort = new AbortController();
        abort.abort();
        await assert.rejects(loader.loadMapVersion('Genesis_WP', abort.signal), {
            name: 'AbortError',
        });
        assert.equal(requests.length, 4);
    } finally {
        globalThis.fetch = original;
    }
});

test('submap indices reject missing defaults, duplicate keys, malformed fields and unknown types', async () => {
    const original = globalThis.fetch;
    const submap = {
        key: 'main',
        name: 'Main',
        type: 'Layer',
        datasetKey: 'Island',
        indexUrl: 'main.json',
    };
    try {
        for (const change of [
            { defaultSubmap: 'missing' },
            { submaps: [] },
            { submaps: [submap, submap] },
            ...[{ type: 'Surface' }, { name: 42 }, { datasetKey: '' }, { indexUrl: '' }].map(
                (change) => ({ submaps: [{ ...submap, ...change }] }),
            ),
        ]) {
            globalThis.fetch = async (input) =>
                String(input).endsWith('index.json')
                    ? Response.json({
                          version: 1,
                          maps: [{ key: 'Island', name: 'Island', indexUrl: 'map.json' }],
                          resourceTypes: [],
                      })
                    : Response.json({
                          version: 2,
                          mapKey: 'Island',
                          defaultSubmap: 'main',
                          submaps: [submap],
                          ...change,
                      });
            await assert.rejects(
                new DataLoader().loadMapIndex('Island'),
                /Invalid map version\/submap index/,
            );
        }
    } finally {
        globalThis.fetch = original;
    }
});
