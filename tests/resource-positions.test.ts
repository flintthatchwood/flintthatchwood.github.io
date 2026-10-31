import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resourcePositions } from '../src/resource-positions.js';
import type { MapResource } from '../src/data/types.js';

const bounds = { originX: -342900, originY: -342900, maxX: 342900, maxY: 342900 };

test('resource positions preserve recorded heights and map Unreal XY to terrain XZ', () => {
    const points: MapResource['points'] = [
        [-10000, 20000, -15000],
        [10000, -20000, 35000],
    ];
    assert.deepEqual(
        Array.from(resourcePositions(points, bounds)),
        [-100, -150, 200, 100, 350, -200],
    );
    assert.equal(points[0][2], -15000);
});

test('resource positions account for nonzero terrain centers', () => {
    assert.deepEqual(
        Array.from(
            resourcePositions([[200, 700, 300]], {
                originX: 100,
                maxX: 500,
                originY: 200,
                maxY: 1000,
            }),
        ),
        [-1, 3, 1],
    );
});

test('invalid resource positions fail explicitly', () => {
    assert.throws(() => resourcePositions([[0, 0, NaN]], bounds), /Invalid resource XYZ/);
    assert.throws(
        () => resourcePositions([[0, 0, 0]], { ...bounds, maxX: Infinity }),
        /Invalid terrain bounds/,
    );
});

test('all Island resources retain their original XYZ, including negative heights', () => {
    const map: { resources: MapResource[] } = JSON.parse(
        readFileSync('root/data/game/TheIsland_WP.json', 'utf8'),
    );
    let total = 0;
    let negative = 0;
    for (const resource of map.resources) {
        const positions = resourcePositions(resource.points, bounds);
        assert.equal(positions.length, resource.points.length * 3);
        resource.points.forEach(([x, y, z], index) => {
            assert.equal(positions[index * 3], Math.fround(x / 100));
            assert.equal(positions[index * 3 + 1], Math.fround(z / 100));
            assert.equal(positions[index * 3 + 2], Math.fround(y / 100));
            if (z < 0) negative++;
        });
        total += resource.points.length;
    }
    assert.ok(total > 0);
    assert.ok(negative > 0);
});
