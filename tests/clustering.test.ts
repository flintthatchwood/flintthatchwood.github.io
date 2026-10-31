import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { cluster } from '../src/clustering/clustering.js';
import { RBush3D } from '../src/clustering/RBush3D.js';

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

test('DBSCAN Clustering with Aberration metal resources', async (t) => {
    // Load Aberration map data
    const dataPath = 'root/data/game/Aberration_WP.json';
    const mapData: MapData = JSON.parse(readFileSync(dataPath, 'utf-8'));

    // Find metal resources
    const metalResource = mapData.resources.find((r) => r.resourceType === 'Metal');
    assert.ok(metalResource, 'Should have Metal resources');

    // Convert to Point3D format for clustering
    const points = metalResource.points.map((coords) => ({
        x: coords[0],
        y: coords[1],
        z: coords[2],
    }));

    console.log(`Testing clustering with ${points.length} metal points`);

    // Build index once and cache it for all clustering tests
    const indexedPoints = points.map((p, i) => ({
        x: p.x,
        y: p.y,
        z: p.z,
        index: i,
    }));
    const index = new RBush3D(indexedPoints);
    console.log(`Built cached R-tree index for clustering`);

    await t.test('can cluster with cached index', () => {
        const results = cluster(index, 8000, 5);
        assert.ok(results.length > 0, 'Should return clustering results');
        assert.ok(index, 'Should have cached index');
    });

    await t.test('can cluster points with reasonable parameters', () => {
        // Use a moderate epsilon and minimum points
        const results = cluster(index, 8000, 5);

        assert.strictEqual(results.length, points.length, 'Should return result for each point');

        // Count clusters and noise points
        const clusterCounts = new Map<number, number>();
        let noiseCount = 0;

        for (const result of results) {
            if (result.clusterId === -1) {
                noiseCount++;
            } else {
                clusterCounts.set(result.clusterId, (clusterCounts.get(result.clusterId) || 0) + 1);
            }
        }

        const numClusters = clusterCounts.size;
        console.log(`Found ${numClusters} clusters and ${noiseCount} noise points`);
        console.log(`Largest cluster has ${Math.max(...clusterCounts.values())} points`);

        assert.ok(numClusters > 0, 'Should find at least one cluster');
        assert.ok(numClusters < points.length / 10, 'Should not have too many tiny clusters');
    });

    await t.test('clustering with tight parameters finds many small clusters', () => {
        // Tight clustering parameters
        const results = cluster(index, 2000, 3);

        const clusterCounts = new Map<number, number>();
        let noiseCount = 0;

        for (const result of results) {
            if (result.clusterId === -1) {
                noiseCount++;
            } else {
                clusterCounts.set(result.clusterId, (clusterCounts.get(result.clusterId) || 0) + 1);
            }
        }

        const numClusters = clusterCounts.size;
        console.log(`Tight clustering: ${numClusters} clusters, ${noiseCount} noise points`);

        // Tight parameters should create more clusters
        assert.ok(numClusters > 10, 'Tight parameters should find many clusters');
    });

    await t.test('clustering with loose parameters finds fewer large clusters', () => {
        // Loose clustering parameters
        const results = cluster(index, 15000, 10);

        const clusterCounts = new Map<number, number>();
        let noiseCount = 0;

        for (const result of results) {
            if (result.clusterId === -1) {
                noiseCount++;
            } else {
                clusterCounts.set(result.clusterId, (clusterCounts.get(result.clusterId) || 0) + 1);
            }
        }

        const numClusters = clusterCounts.size;
        const avgClusterSize = numClusters > 0 ? (points.length - noiseCount) / numClusters : 0;

        console.log(
            `Loose clustering: ${numClusters} clusters, avg size: ${avgClusterSize.toFixed(1)}, ${noiseCount} noise`,
        );

        // Loose parameters should create fewer, larger clusters
        assert.ok(avgClusterSize > 50, 'Loose parameters should create larger clusters on average');
    });

    await t.test('all result indices are valid', () => {
        const results = cluster(index, 8000, 5);

        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            assert.strictEqual(result.pointIndex, i, `Point index should match array position`);
            assert.ok(result.clusterId >= -1, 'Cluster ID should be -1 (noise) or positive');
        }
    });

    await t.test('clustering performance is reasonable', () => {
        const start = performance.now();
        const results = cluster(index, 8000, 5);
        const elapsed = performance.now() - start;

        console.log(`Clustering ${results.length} points took ${elapsed.toFixed(2)}ms`);

        assert.ok(elapsed < 5000, 'Clustering should complete within 5 seconds'); // Generous timeout
        assert.strictEqual(results.length, points.length, 'Should return result for each point');
    });

    await t.test('empty input returns empty results', () => {
        const emptyIndex = new RBush3D([]);
        const results = cluster(emptyIndex, 1000, 3);

        assert.strictEqual(results.length, 0, 'Empty input should return empty results');
    });

    await t.test('single point becomes noise', () => {
        const singlePointIndex = new RBush3D([{ x: 0, y: 0, z: 0, index: 0 }]);
        const results = cluster(singlePointIndex, 1000, 2);

        assert.strictEqual(results.length, 1, 'Should return one result');
        assert.strictEqual(results[0].clusterId, -1, 'Single point should be noise');
        assert.strictEqual(results[0].pointIndex, 0, 'Point index should be 0');
    });

    await t.test('clustered points are actually close to each other', () => {
        const epsilon = 5000;
        const results = cluster(index, epsilon, 3);

        // Get points from index for verification
        const indexPoints = index.points;

        // Group results by cluster
        const clusters = new Map<number, number[]>();
        for (const result of results) {
            if (result.clusterId !== -1) {
                // Skip noise points
                if (!clusters.has(result.clusterId)) {
                    clusters.set(result.clusterId, []);
                }
                clusters.get(result.clusterId)!.push(result.pointIndex);
            }
        }

        // Check a few random clusters to ensure points are actually close
        const clusterIds = Array.from(clusters.keys());
        const samplesToCheck = Math.min(5, clusterIds.length);

        for (let i = 0; i < samplesToCheck; i++) {
            const clusterId = clusterIds[i];
            const pointIndices = clusters.get(clusterId)!;

            if (pointIndices.length < 2) continue;

            // Check that all points in the cluster are within reasonable distance
            const firstPoint = indexPoints[pointIndices[0]];
            let maxDistance = 0;

            for (const idx of pointIndices) {
                const point = indexPoints[idx];
                const dx = firstPoint.x - point.x;
                const dy = firstPoint.y - point.y;
                const dz = firstPoint.z - point.z;
                const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
                maxDistance = Math.max(maxDistance, distance);
            }

            // The diameter of the cluster should be reasonable (not more than ~3x epsilon in most cases)
            const maxExpectedDiameter = epsilon * 3;

            assert.ok(
                maxDistance <= maxExpectedDiameter,
                `Cluster ${clusterId} diameter ${maxDistance.toFixed(1)} should be <= ${maxExpectedDiameter} (3x epsilon)`,
            );
        }

        console.log(`Verified clustering quality on ${samplesToCheck} sample clusters`);
    });
});
