// Data Layer - Data loading and management

import { IndexData, MapData, MapInfo, ResourceType } from './types.js';

export class DataLoader {
    private indexData: IndexData | null = null;

    async loadIndex(): Promise<IndexData> {
        const response = await fetch('./data/index.json');
        if (!response.ok) {
            throw new Error(`Failed to load index.json: ${response.status} ${response.statusText}`);
        }
        this.indexData = await response.json();

        if (!this.indexData) {
            throw new Error('Index data is null or undefined');
        }

        return this.indexData;
    }

    async loadMapData(dataUrl: string): Promise<MapData> {
        const normalizedUrl =
            dataUrl.startsWith('http') || dataUrl.startsWith('/')
                ? dataUrl
                : `./data/${dataUrl.replace(/^\.\//, '')}`;

        const response = await fetch(normalizedUrl);
        if (!response.ok) {
            throw new Error(
                `Failed to load map data from ${normalizedUrl}: ${response.status} ${response.statusText}`,
            );
        }

        const data: any = await response.json();
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

        return this.loadMapData(mapInfo.dataUrl);
    }
}
