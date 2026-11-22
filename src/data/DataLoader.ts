// Data Layer - Data loading and management

import { IndexData, MapData, MapInfo, MapVersion, MapIndex, ResourceType } from './types.js';
import { json } from '../metadata.js';

export const DATA_INDEX_URL = 'https://arkres.blob.core.windows.net/terrain/index.json';

export class DataLoader {
    private indexData: IndexData | null = null;
    private mapIndexes = new Map<string, MapIndex>();
    private versions = new Map<string, MapVersion>();

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
        this.mapIndexes.clear();
        this.versions.clear();
        return this.indexData;
    }

    async loadMapIndex(mapKey: string, signal?: AbortSignal): Promise<MapIndex> {
        if (!this.indexData) await this.loadIndex();
        signal?.throwIfAborted();
        const cached = this.mapIndexes.get(mapKey);
        if (cached) return cached;
        const info = this.getMaps().find(map => map.key === mapKey);
        if (!info) throw new Error(`Map ${mapKey} not found`);
        const url = new URL(info.indexUrl, this.indexUrl);
        const data = await json<MapIndex | MapVersion>(url.href, signal);
        signal?.throwIfAborted();
        let index: MapIndex;
        if (data.version === 1) {
            this.versions.set(`${mapKey}:main`, this.resolveVersion(data, mapKey, url));
            index = {
                version: 2,
                mapKey,
                defaultSubmap: 'main',
                submaps: [
                    {
                        key: 'main',
                        name: 'Main',
                        type: 'Layer',
                        datasetKey: mapKey,
                        indexUrl: url.href,
                    },
                ],
            };
        } else {
            if (
                data.version !== 2 ||
                data.mapKey !== mapKey ||
                !Array.isArray(data.submaps) ||
                !data.submaps.length ||
                data.submaps.some(
                    (submap) =>
                        !submap ||
                        typeof submap.key !== 'string' ||
                        !submap.key ||
                        typeof submap.name !== 'string' ||
                        !submap.name ||
                        typeof submap.datasetKey !== 'string' ||
                        !submap.datasetKey ||
                        typeof submap.indexUrl !== 'string' ||
                        !submap.indexUrl ||
                        !['Layer', 'Arena', 'Cave'].includes(submap.type),
                ) ||
                new Set(data.submaps.map((submap) => submap.key)).size !==
                    data.submaps.length ||
                new Set(data.submaps.map((submap) => submap.datasetKey)).size !== data.submaps.length ||
                !data.submaps.some((submap) => submap.key === data.defaultSubmap)
            )
                throw new Error(`Invalid map version/submap index for ${mapKey}`);
            index = {
                ...data,
                submaps: data.submaps.map((submap) => ({
                    ...submap,
                    indexUrl: new URL(submap.indexUrl, url).href,
                })),
            };
        }
        this.mapIndexes.set(mapKey, index);
        return index;
    }

    async loadMapVersion(
        mapKey: string,
        signal?: AbortSignal,
        submapKey?: string,
    ): Promise<MapVersion> {
        const index = await this.loadMapIndex(mapKey, signal);
        const key = submapKey ?? index.defaultSubmap;
        const submap = index.submaps.find((submap) => submap.key === key);
        if (!submap) throw new Error(`Unknown submap ${key} for ${mapKey}`);
        signal?.throwIfAborted();
        const cached = this.versions.get(`${mapKey}:${key}`);
        if (cached) {
            this.versions.delete(`${mapKey}:${key}`);
            return cached;
        }
        const url = new URL(submap.indexUrl);
        const version = this.resolveVersion(
            await json<MapVersion>(url.href, signal),
            submap.datasetKey,
            url,
        );
        signal?.throwIfAborted();
        return version;
    }

    private resolveVersion(version: MapVersion, mapKey: string, url: URL): MapVersion {
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
