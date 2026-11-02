import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, type TerrainManifest } from '../src/terrain.js';

function fixture(): TerrainManifest {
    return {
        version: 2,
        mapKey: 'Island',
        heightUnits: 'centimeters',
        originX: -100,
        originY: -100,
        maxX: 100,
        maxY: 100,
        minZ: -200,
        maxZ: 200,
        warnings: [],
        worldModel: { url: 'world.json' },
        blockModel: { url: 'blocks.json' },
        cubeModel: { url: 'cubes.json' },
        progressiveModel: { url: 'progressive.json' },
    };
}

test('3D map metadata needs no sampled height grid', () => {
    assert.doesNotThrow(() => validateManifest(fixture(), 'Island'));
    const unavailable = fixture();
    delete unavailable.worldModel;
    delete unavailable.blockModel;
    delete unavailable.progressiveModel;
    delete unavailable.cubeModel;
    assert.doesNotThrow(() => validateManifest(unavailable, 'Island'));
});

test('3D map metadata rejects old heightfields and malformed bounds or links', () => {
    for (const change of [
        { version: 1 },
        { mapKey: 'Other' },
        { originX: 100 },
        { minZ: NaN },
        { maxZ: -201 },
        { warnings: [null] },
        { tiles: [] },
        { spacing: 500 },
        { worldModel: null },
        { blockModel: { url: '' } },
        { cubeModel: { url: '' } },
        { progressiveModel: { url: 1 } },
        { progressiveModel: { url: 'progressive.json', default: 'yes' } },
    ]) {
        assert.throws(() =>
            validateManifest({ ...fixture(), ...change } as TerrainManifest, 'Island'),
        );
    }
});

test('terrain manifests remain metadata-only without requiring generated files in the checkout', () => {
    const manifest = fixture();
    validateManifest(JSON.parse(JSON.stringify(manifest)), 'Island');
    assert.ok(!('tiles' in manifest));
    assert.ok(!('spacing' in manifest));
});
