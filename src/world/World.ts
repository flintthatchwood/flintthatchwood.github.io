import { RBush3D, Point3D, IndexedPoint3D } from '../clustering/rbush3d.js';
import { cluster } from '../clustering/clustering.js';
import type { MapData, CoordinateSystem, ResourceType } from '../data/types.js';

export interface WorldSettings {
    mapData: MapData;
    resourceTypes: ResourceType[];
}

export interface ClusterConfig {
    enabled: boolean;
    radius: number;
    minClusterSize: number;
    maxLevels: number;
}

export interface NodePoint {
    x: number;
    y: number;
    z: number;
    type: 'node';
    resourceType: string;
    color: string;
    colorHex: string;
    index: number; // Original point index for nodes
}

export interface ClusterPoint {
    x: number;
    y: number;
    z: number;
    type: 'cluster';
    resourceType: string;
    count: number;
    color: string;
    colorHex: string;
    indices: number[]; // Original point indices for clusters
    radius: number;
}

export type WorldPoint = NodePoint | ClusterPoint;

export interface WorldPointsByResource {
    [resourceType: string]: WorldPoint[];
}

export class World {
    private mapData: MapData | null = null;
    private resourceTypes: Map<string, { color: string; colorHex: string }> = new Map();
    private spatialIndices: Map<string, RBush3D> = new Map();
    private cachedPoints: Map<string, WorldPoint[]> = new Map();
    private allPointsCache: WorldPoint[] | null = null;

    // Public configuration - changing this triggers reclustering
    private clusterConfigState: ClusterConfig = {
        enabled: true,
        radius: 5000,
        minClusterSize: 3,
        maxLevels: 4,
    };

    // Callbacks
    public onPointsChanged?: () => void;

    constructor(settings?: WorldSettings) {
        if (settings) {
            this.setMapData(settings.mapData, settings.resourceTypes);
        }
    }

    setMapData(mapData: MapData, resourceTypes: ResourceType[]): void {
        this.mapData = mapData;
        this.resourceTypes = new Map(
            resourceTypes.map((type) => [
                type.name,
                { color: type.color, colorHex: type.colorHex },
            ]),
        );
        this.initializeSpatialIndices();
        this.updateClustering();
    }

    get clusterConfig(): ClusterConfig {
        return { ...this.clusterConfigState };
    }

    set clusterConfig(config: ClusterConfig) {
        this.clusterConfigState = { ...config };
        this.updateClustering();
    }

    updateClusterConfig(config: Partial<ClusterConfig>): void {
        this.clusterConfigState = { ...this.clusterConfigState, ...config };
        this.updateClustering();
    }

    get coordinateSystem(): CoordinateSystem {
        return this.ensureMapData().coordinates;
    }

    get mapKey(): string {
        return this.ensureMapData().mapKey;
    }

    get imageName(): string | undefined {
        return this.ensureMapData().imageName;
    }

    // Get all points from all resource types
    get points(): WorldPoint[] {
        if (!this.mapData) return [];
        if (this.allPointsCache === null) {
            this.allPointsCache = Array.from(this.cachedPoints.values()).flat();
        }
        return this.allPointsCache;
    }

    // Get points grouped by resource type
    get pointsByResource(): WorldPointsByResource {
        const result: WorldPointsByResource = {};
        for (const [resourceType, points] of this.cachedPoints) {
            result[resourceType] = points;
        }
        return result;
    }

    // Get points for a specific resource type
    getPointsForResource(resourceType: string): WorldPoint[] {
        return this.cachedPoints.get(resourceType) || [];
    }

    // Search for points within a radius (useful for hover detection)
    searchRadius(
        x: number,
        y: number,
        z: number,
        radius: number,
        resourceType?: string,
    ): WorldPoint[] {
        const results: WorldPoint[] = [];

        if (!this.mapData) {
            return results;
        }

        if (resourceType) {
            // Search specific resource type
            const spatialIndex = this.spatialIndices.get(resourceType);
            if (spatialIndex) {
                const nearby = spatialIndex.searchRadius(x, y, z, radius);
                results.push(...this.convertToWorldPoints(nearby, resourceType));
            }
        } else {
            // Search all resource types
            for (const [resType, spatialIndex] of this.spatialIndices) {
                const nearby = spatialIndex.searchRadius(x, y, z, radius);
                results.push(...this.convertToWorldPoints(nearby, resType));
            }
        }

        return results;
    }

    // Get all resource types available in this world
    get availableResourceTypes(): string[] {
        return Array.from(this.resourceTypes.keys());
    }

    private initializeSpatialIndices(): void {
        if (!this.mapData) return;

        this.spatialIndices.clear();
        this.cachedPoints.clear();
        this.allPointsCache = null;

        for (const resource of this.mapData.resources) {
            const points: IndexedPoint3D[] = resource.points.map((point, index) => ({
                x: point[0],
                y: point[1],
                z: point[2],
                index,
            }));

            const spatialIndex = new RBush3D(points);
            this.spatialIndices.set(resource.resourceType, spatialIndex);
        }
    }

    private updateClustering(): void {
        if (!this.mapData) return;

        this.cachedPoints.clear();
        this.allPointsCache = null;

        for (const [resourceType, spatialIndex] of this.spatialIndices) {
            if (this.clusterConfigState.enabled) {
                const worldPoints = this.createClusteredPoints(spatialIndex, resourceType);
                this.cachedPoints.set(resourceType, worldPoints);
            } else {
                // No clustering - show all individual points
                const worldPoints = this.convertToWorldPoints(spatialIndex.points, resourceType);
                this.cachedPoints.set(resourceType, worldPoints);
            }
        }

        // Notify listeners
        this.onPointsChanged?.();
    }

    private convertToWorldPoints(points: IndexedPoint3D[], resourceType: string): WorldPoint[] {
        const resourceInfo = this.resourceTypes.get(resourceType);
        if (!resourceInfo) return [];

        return points.map(
            (point): NodePoint => ({
                x: point.x,
                y: point.y,
                z: point.z,
                type: 'node',
                resourceType,
                color: resourceInfo.color,
                colorHex: resourceInfo.colorHex,
                index: point.index,
            }),
        );
    }

    private createClusteredPoints(spatialIndex: RBush3D, resourceType: string): WorldPoint[] {
        const resourceInfo = this.resourceTypes.get(resourceType);
        if (!resourceInfo) return [];

        const results = cluster(
            spatialIndex,
            this.clusterConfigState.radius,
            this.clusterConfigState.minClusterSize,
        );
        const clusters = new Map<number, number[]>();
        const noiseIndices: number[] = [];

        for (const result of results) {
            if (result.clusterId === -1) {
                noiseIndices.push(result.pointIndex);
                continue;
            }

            if (!clusters.has(result.clusterId)) {
                clusters.set(result.clusterId, []);
            }
            clusters.get(result.clusterId)!.push(result.pointIndex);
        }

        const worldPoints: WorldPoint[] = [];
        const points = spatialIndex.points;

        for (const indices of clusters.values()) {
            const center = indices.reduce(
                (acc, index) => {
                    const point = points[index];
                    acc.x += point.x;
                    acc.y += point.y;
                    acc.z += point.z;
                    return acc;
                },
                { x: 0, y: 0, z: 0 },
            );

            center.x /= indices.length;
            center.y /= indices.length;
            center.z /= indices.length;

            worldPoints.push({
                x: center.x,
                y: center.y,
                z: center.z,
                type: 'cluster',
                resourceType,
                count: indices.length,
                color: resourceInfo.color,
                colorHex: resourceInfo.colorHex,
                indices: indices.map((index) => points[index].index),
                radius: this.clusterConfigState.radius,
            });
        }

        for (const index of noiseIndices) {
            const point = points[index];
            worldPoints.push({
                x: point.x,
                y: point.y,
                z: point.z,
                type: 'node',
                resourceType,
                color: resourceInfo.color,
                colorHex: resourceInfo.colorHex,
                index: point.index,
            });
        }

        return worldPoints;
    }

    getPointInfo(
        _pointId: string,
    ): { type: string; count?: number; position: { x: number; y: number; z: number } } | null {
        // Implementation for getting point information for hover display
        // This would need to be implemented based on how you want to identify points
        return null;
    }

    getCurrentPoints(): WorldPoint[] {
        return this.points;
    }

    private ensureMapData(): MapData {
        if (!this.mapData) {
            throw new Error('Map data not set. Call setMapData() first.');
        }
        return this.mapData;
    }

    getResourceTypes(): { name: string; color: string; colorHex: string }[] {
        return Array.from(this.resourceTypes.entries()).map(([name, { color, colorHex }]) => ({
            name,
            color,
            colorHex,
        }));
    }
}
