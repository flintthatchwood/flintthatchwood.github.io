// Data Layer - Data loading and management

import { IndexData, MapData, MapInfo, MapVersion, ResourceType } from './types.js';
import { json } from '../metadata.js';

export const DATA_INDEX_URL = 'https://arkres.blob.core.windows.net/terrain/index.json';

export class DataLoader {
    private indexData: IndexData | null = null;

    constructor(private readonly indexUrl = DATA_INDEX_URL) {}

    async loadIndex(): Promise<IndexData> {
        const response = await fetch(this.indexUrl, { cache: 'no-cache' });
        if (!response.ok) {
            throw new Error(`Failed to load index.json: ${response.status} ${response.statusText}`);
        }
        const data = await response.json() as IndexData & { version: number };
        if (data.version !== 1 || !Array.isArray(data.maps) || !Array.isArray(data.resourceTypes) ||
            data.maps.some(map => !map.key || !map.name || !map.indexUrl)) {
            throw new Error('Invalid site data index');
        }
        this.indexData = data;
        return this.indexData;
    }

    async loadMapVersion(mapKey: string, signal?: AbortSignal): Promise<MapVersion> {
        if (!this.indexData) await this.loadIndex();
        const info = this.getMaps().find(map => map.key === mapKey);
        if (!info) throw new Error(`Map ${mapKey} not found`);
        const url = new URL(info.indexUrl, this.indexUrl);
        const version = await json<MapVersion>(url.href, signal);
        if (version.version !== 1 || version.mapKey !== mapKey ||
            typeof version.dataUrl !== 'string' || !version.dataUrl ||
            typeof version.imageUrl !== 'string' || !version.imageUrl ||
            (version.terrainUrl !== null && (typeof version.terrainUrl !== 'string' || !version.terrainUrl))) {
            throw new Error(`Invalid map version for ${mapKey}`);
        }
        return {
            ...version,
            dataUrl: new URL(version.dataUrl, url).href,
            imageUrl: new URL(version.imageUrl, url).href,
            terrainUrl: version.terrainUrl === null ? null : new URL(version.terrainUrl, url).href,
        };
    }

    async loadMapData(dataUrl: string): Promise<MapData> {
        const normalizedUrl = new URL(dataUrl, this.indexUrl).href;

        const response = await fetch(normalizedUrl);
        if (!response.ok) {
            throw new Error(
                `Failed to load map data from ${normalizedUrl}: ${response.status} ${response.statusText}`,
            );
        }

        const data: ConstructorParameters<typeof MapData>[0] = await response.json();
        return new MapData(data);
    }

    getResourceTypes(): ResourceType[] {
        if (!this.indexData) {
            throw new Error('Index data not loaded. Call loadIndex() first.');
        }
        return this.indexData.resourceTypes;
    }

    getMaps(): MapInfo[] {
        if (!this.indexData) {
            throw new Error('Index data not loaded. Call loadIndex() first.');
        }
        return this.indexData.maps;
    }

    async getMapList(): Promise<MapInfo[]> {
        if (!this.indexData) {
            await this.loadIndex();
        }
        return this.getMaps();
    }

    async loadMapByName(mapKey: string): Promise<MapData> {
        if (!this.indexData) {
            await this.loadIndex();
        }

        const mapInfo = this.getMaps().find((map) => map.key === mapKey);
        if (!mapInfo) {
            throw new Error(`Map ${mapKey} not found`);
        }

        const version = await this.loadMapVersion(mapKey);
        return this.loadMapData(version.dataUrl);
    }
}
