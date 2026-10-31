import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { IndexData } from '../src/data/types.js';
import { groupedMaps, mapKeyFromUrl, mapUrl, orderedMaps } from '../src/map-navigation.js';

const maps = [
    { key: 'Aberration_WP', name: 'Aberration', dataUrl: 'game/Aberration_WP.json' },
    { key: 'TheIsland_WP', name: 'The Island', dataUrl: 'game/TheIsland_WP.json' },
    { key: 'Extinction_WP', name: 'Extinction', dataUrl: 'game/Extinction_WP.json' },
];

test('The Island comes first without mutating the index', () => {
    assert.deepEqual(
        orderedMaps(maps).map((map) => map.key),
        ['TheIsland_WP', 'Aberration_WP', 'Extinction_WP'],
    );
    assert.equal(maps[0].key, 'Aberration_WP');
    assert.deepEqual(orderedMaps([maps[0], maps[2]]), [maps[0], maps[2]]);
});

test('published maps are grouped in the specified canon and alphabetical DLC order', () => {
    const index: IndexData = JSON.parse(readFileSync('root/data/index.json', 'utf8'));
    const originalKeys = index.maps.map((map) => map.key);
    const groups = groupedMaps(index.maps);
    assert.deepEqual(
        groups.map((group) => ({ label: group.label, names: group.maps.map((map) => map.name) })),
        [
            {
                label: 'Canon',
                names: [
                    'The Island',
                    'Scorched Earth',
                    'Aberration',
                    'Extinction',
                    'Lost Colony',
                    'Genesis (Main)',
                    'Genesis (Ocean)',
                ],
            },
            {
                label: 'Official DLC',
                names: ['Astraeos', 'Ragnarok', 'The Center', 'Valguero'],
            },
            { label: 'Other', names: ['Forglar', 'Survive The Night', 'Svartalfheim'] },
        ],
    );
    assert.deepEqual(
        index.maps.map((map) => map.key),
        originalKeys,
    );
    assert.deepEqual(
        orderedMaps(index.maps)
            .map((map) => map.key)
            .sort(),
        [...originalKeys].sort(),
    );
});

test('unknown maps remain available in Other and empty sections are omitted', () => {
    const extra = [
        { key: 'Zeta_WP', name: 'Zeta', dataUrl: 'mods/zeta.json' },
        { key: 'Alpha_WP', name: 'Alpha', dataUrl: 'mods/alpha.json' },
    ];
    assert.deepEqual(groupedMaps(extra), [{ label: 'Other', maps: [extra[1], extra[0]] }]);
    assert.deepEqual(groupedMaps([]), []);
});

test('URLs without a map default to The Island in the ordered list', () => {
    assert.equal(
        mapKeyFromUrl(new URL('https://viewer.invalid/'), orderedMaps(maps)),
        'TheIsland_WP',
    );
});

test('shared map URLs override the default', () => {
    assert.equal(
        mapKeyFromUrl(new URL('https://viewer.invalid/?map=Extinction_WP'), orderedMaps(maps)),
        'Extinction_WP',
    );
});

test('unknown or empty map keys and empty indexes fail explicitly', () => {
    for (const key of ['Missing_WP', '']) {
        assert.throws(
            () => mapKeyFromUrl(new URL(`https://viewer.invalid/?map=${key}`), maps),
            /Unknown map/,
        );
    }
    assert.throws(
        () => mapKeyFromUrl(new URL('https://viewer.invalid/'), []),
        /No maps are available/,
    );
});

test('map URL updates preserve the path, other parameters and fragment', () => {
    const original = new URL('https://viewer.invalid/subsite/?other=value&map=Aberration_WP#info');
    const updated = mapUrl(original, 'TheIsland_WP');
    assert.equal(updated.href, 'https://viewer.invalid/subsite/?other=value&map=TheIsland_WP#info');
    assert.equal(original.searchParams.get('map'), 'Aberration_WP');
    assert.equal(mapKeyFromUrl(updated, maps), 'TheIsland_WP');
});

test('map URL updates canonicalize repeated parameters and encode map keys', () => {
    const updated = mapUrl(
        new URL('https://viewer.invalid/?map=Aberration_WP&map=Extinction_WP'),
        'Mod Map & Cave',
    );
    assert.deepEqual(updated.searchParams.getAll('map'), ['Mod Map & Cave']);
    assert.equal(
        mapKeyFromUrl(updated, [{ key: 'Mod Map & Cave', name: 'Mod', dataUrl: 'mod.json' }]),
        'Mod Map & Cave',
    );
});
