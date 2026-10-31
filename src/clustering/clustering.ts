import { RBush3D } from './rbush3d.js';

export interface ClusterResult {
    clusterId: number; // -1 for noise/unassigned
    pointIndex: number;
}

export function cluster(
    spatialIndex: RBush3D,
    epsilon: number,
    minPoints: number,
): ClusterResult[] {
    const n = spatialIndex.length;
    const labels = new Array(n).fill(-1); // -1 = unassigned
    let clusterId = 0;

    for (let i = 0; i < n; i++) {
        if (labels[i] !== -1) continue; // Already processed

        // Find neighbors within epsilon
        const neighbors = getNeighbors(spatialIndex, i, epsilon);

        if (neighbors.length < minPoints) {
            labels[i] = -1; // Mark as noise
            continue;
        }

        // Start a new cluster
        clusterId++;
        expandCluster(i, neighbors, clusterId, labels, spatialIndex, epsilon, minPoints);
    }

    return labels.map((clusterId, pointIndex) => ({
        clusterId,
        pointIndex,
    }));
}

function expandCluster(
    pointIndex: number,
    neighbors: number[],
    clusterId: number,
    labels: number[],
    spatialIndex: RBush3D,
    epsilon: number,
    minPoints: number,
): void {
    labels[pointIndex] = clusterId;

    const queue = [...neighbors];

    while (queue.length > 0) {
        const currentIndex = queue.shift()!;

        if (labels[currentIndex] === -1) {
            labels[currentIndex] = clusterId;
        }

        if (labels[currentIndex] !== -1) continue;

        labels[currentIndex] = clusterId;

        const currentNeighbors = getNeighbors(spatialIndex, currentIndex, epsilon);

        if (currentNeighbors.length >= minPoints) {
            queue.push(...currentNeighbors);
        }
    }
}

function getNeighbors(spatialIndex: RBush3D, pointIndex: number, epsilon: number): number[] {
    const point = spatialIndex.points[pointIndex];

    // Find all points within epsilon distance using 3D R-tree
    const candidates = spatialIndex.searchRadius(point.x, point.y, point.z, epsilon);
    const neighbors: number[] = [];

    for (const candidate of candidates) {
        if (candidate.index === pointIndex) continue;
        neighbors.push(candidate.index);
    }

    return neighbors;
}
