import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { initialRepresentation, validateManifest, type TerrainManifest } from '../src/terrain.js';

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

test('cubes are default and legacy triangle URLs map to the only triangle option', () => {
    const m = fixture();
    assert.equal(initialRepresentation(m, null), 'cubes');
    assert.equal(initialRepresentation(m, 'triangles'), 'triangles');
    assert.equal(initialRepresentation(m, 'progressive'), 'triangles');
    m.progressiveModel!.default = true;
    assert.equal(initialRepresentation(m, null), 'cubes');
    assert.equal(initialRepresentation(m, 'mesh'), 'triangles');
    assert.equal(initialRepresentation(m, 'blocks'), 'cubes');
    assert.doesNotThrow(() => validateManifest(m, 'Island'));
    delete m.cubeModel;
    assert.equal(initialRepresentation(m, null), 'triangles');
    delete m.progressiveModel;
    assert.throws(() => initialRepresentation(m, null), /No 3D extraction/);
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

test('all published maps contain only bounds and 3D links, without fallback height tiles', () => {
    const root = join('root', 'terrain');
    const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as {
        maps: { mapKey: string; url: string }[];
    };
    for (const entry of index.maps) {
        const path = join(root, entry.url);
        const manifest = JSON.parse(readFileSync(path, 'utf8')) as TerrainManifest;
        validateManifest(manifest, entry.mapKey);
        assert.ok(!readdirSync(dirname(path)).some((name) => /^\d+-\d+\.f32$/.test(name)), path);
    }
});
