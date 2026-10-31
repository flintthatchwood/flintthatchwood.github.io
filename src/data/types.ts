// Data Layer - Pure data types and interfaces, no logic

import { isNullOrUndefined } from "util";
import { Point3D } from "../clustering/rbush3d";

export interface ArkCoordinates {
    lat: number;
    long: number;
    z: number;
}

export class CoordinateSystem {
    public minX: number;
    public maxX: number;
    public minY: number;
    public maxY: number;
    public minZ: number;
    public maxZ: number;
    public centerX: number;
    public centerY: number;
    public scaleX: number;
    public scaleY: number;

    constructor(
        minX: number,
        maxX: number,
        minY: number,
        maxY: number,
        minZ: number,
        maxZ: number,
        centerX: number,
        centerY: number,
        scaleX: number,
        scaleY: number,
    ) {
        this.minX = minX;
        this.maxX = maxX;
        this.minY = minY;
        this.maxY = maxY;
        this.minZ = minZ;
        this.maxZ = maxZ;
        this.centerX = centerX;
        this.centerY = centerY;
        this.scaleX = scaleX;
        this.scaleY = scaleY;
    }
    
    public getArkCoordinates(worldCoords: Point3D): ArkCoordinates
    {
        // Measure the distance from world center, scale it, then account for afk calling the center 50, 50
        // If scaleX is 10000, then every 10000 world units is 1 ark longitude unit
        // With a world.x of 125000 with a centerX of 25000, the world point is 100000 units to the right of center
        // so 100000 / 10000 = 10, plus 50 = 60 longitude

        const lat = ((worldCoords.y - this.centerY) / this.scaleY) + 50;
        const long = ((worldCoords.x - this.centerX) / this.scaleX) + 50;
        const z = worldCoords.z;
        return { lat, long, z };
    }
}

export interface ResourceType {
    name: string;
    color: string;
    colorHex: string;
}

export interface MapInfo {
    key: string;
    name: string;
    modName?: string;
    dataUrl: string;
}

export interface MapResource {
    resourceType: string;
    points: [number, number, number][];
}

export class MapData {
    mapKey: string;
    coordinates: CoordinateSystem;
    resources: MapResource[];
    imageName?: string;

    constructor(data: any) {
        this.mapKey = data.mapKey;
        this.coordinates = new CoordinateSystem(
            data.coordinates.minX,
            data.coordinates.maxX,
            data.coordinates.minY,
            data.coordinates.maxY,
            data.coordinates.minZ,
            data.coordinates.maxZ,
            data.coordinates.centerX,
            data.coordinates.centerY,
            data.coordinates.scaleX,
            data.coordinates.scaleY
        );
        this.resources = data.resources;
        this.imageName = data.imageName;
    }
}

export interface IndexData {
    resourceTypes: ResourceType[];
    maps: MapInfo[];
}

// Raw point data from the data files
export interface RawPoint {
    x: number;
    y: number;
    z: number;
}
