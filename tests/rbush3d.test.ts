import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { RBush3D } from '../src/clustering/rbush3d.js';

interface MapData {
    mapKey: string;
    coordinates: {
        worldSize: number;
        offsetX: number;
        offsetY: number;
        offsetZ: number;
    };
    resources: Array<{
        resourceType: string;
        points: number[][]; // Array of [x, y, z] arrays
    }>;
}

test('RBush3D with Aberration metal resources', async (t) => {
    // Load Aberration map data
    const dataPath = 'root/data/game/Aberration_WP.json';
    const mapData: MapData = JSON.parse(readFileSync(dataPath, 'utf-8'));

    // Find metal resources
    const metalResource = mapData.resources.find((r) => r.resourceType === 'Metal');
    assert.ok(metalResource, 'Should have Metal resources');

    // Each point is [x, y, z]
    const metalPoints = metalResource.points.map((coords, i) => ({
        x: coords[0],
        y: coords[1],
        z: coords[2],
        index: i,
    }));

    console.log(`Loaded ${metalPoints.length} metal points from Aberration`);
    console.log(`First 3 points:`, metalPoints.slice(0, 3));
    assert.ok(metalPoints.length > 0, 'Should have metal points');

    // Build index once and cache it for all tests
    const index = new RBush3D(metalPoints);
    console.log(`Built R-tree with ${metalPoints.length} points`);

    await t.test('can build index from points', () => {
        assert.ok(index, 'Index should be created');
        assert.ok(metalPoints.length > 0, 'Index should contain points');
    });

    await t.test('can search for points in radius', () => {
        // Pick the first point and find its nearest neighbor to determine good search radius
        const centerPoint = metalPoints[0];

        // Find nearest neighbor with brute force
        let minDist = Infinity;
        for (const point of metalPoints) {
            if (point.index === centerPoint.index) continue;
            const dx = centerPoint.x - point.x;
            const dy = centerPoint.y - point.y;
            const dz = centerPoint.z - point.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            minDist = Math.min(minDist, dist);
        }

        console.log(`Nearest neighbor is ${minDist.toFixed(2)} units away`);

        // Use 2x the nearest neighbor distance as search radius
        const searchRadius = minDist * 2;

        const neighbors = index.searchRadius(
            centerPoint.x,
            centerPoint.y,
            centerPoint.z,
            searchRadius,
        );

        console.log(`Found ${neighbors.length} neighbors within ${searchRadius.toFixed(2)} units`);
        assert.ok(neighbors.length > 0, 'Should find at least the point itself');

        // Verify all returned points are actually within radius
        for (const neighbor of neighbors) {
            const point = metalPoints[neighbor.index];
            const dx = centerPoint.x - point.x;
            const dy = centerPoint.y - point.y;
            const dz = centerPoint.z - point.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

            assert.ok(
                dist <= searchRadius,
                `Point ${neighbor.index} at distance ${dist} should be within ${searchRadius}`,
            );
        }
    });

    await t.test('search results match brute force', () => {
        // Pick a random point
        const centerIdx = Math.floor(metalPoints.length / 2);
        const centerPoint = metalPoints[centerIdx];
        const searchRadius = 10000;

        // R-tree search
        const rtreeResults = index.searchRadius(
            centerPoint.x,
            centerPoint.y,
            centerPoint.z,
            searchRadius,
        );

        // Brute force search
        const bruteForceResults: number[] = [];
        for (let i = 0; i < metalPoints.length; i++) {
            const point = metalPoints[i];
            const dx = centerPoint.x - point.x;
            const dy = centerPoint.y - point.y;
            const dz = centerPoint.z - point.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

            if (dist <= searchRadius) {
                bruteForceResults.push(i);
            }
        }

        console.log(
            `R-tree found ${rtreeResults.length}, brute force found ${bruteForceResults.length}`,
        );

        // Sort both arrays for comparison
        const rtreeIndices = rtreeResults.map((p) => p.index).sort((a, b) => a - b);
        const bruteIndices = bruteForceResults.sort((a, b) => a - b);

        assert.deepStrictEqual(
            rtreeIndices,
            bruteIndices,
            'R-tree should return same results as brute force',
        );
    });

    await t.test('performance comparison', () => {
        const searchRadius = 8000;
        const numSearches = 100;

        // Time R-tree searches using cached index
        const rtreeStart = performance.now();
        for (let i = 0; i < numSearches; i++) {
            const centerPoint = metalPoints[i % metalPoints.length];
            index.searchRadius(centerPoint.x, centerPoint.y, centerPoint.z, searchRadius);
        }
        const rtreeTime = performance.now() - rtreeStart;

        // Time brute force searches
        const bruteStart = performance.now();
        for (let i = 0; i < numSearches; i++) {
            const centerPoint = metalPoints[i % metalPoints.length];
            let count = 0;
            for (const point of metalPoints) {
                const dx = centerPoint.x - point.x;
                const dy = centerPoint.y - point.y;
                const dz = centerPoint.z - point.z;
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (dist <= searchRadius) count++;
            }
            if (count < 0) {
                throw new Error('Unexpected count');
            }
        }
        const bruteTime = performance.now() - bruteStart;

        console.log(`R-tree: ${rtreeTime.toFixed(2)}ms, Brute force: ${bruteTime.toFixed(2)}ms`);
        console.log(`Speedup: ${(bruteTime / rtreeTime).toFixed(2)}x`);

        assert.ok(rtreeTime < bruteTime, 'R-tree should be faster than brute force');
    });
});
