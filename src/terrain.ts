export interface TerrainManifest {
    version: 2;
    mapKey: string;
    heightUnits: 'centimeters';
    originX: number;
    originY: number;
    maxX: number;
    maxY: number;
    minZ: number;
    maxZ: number;
    warnings: string[];
    worldModel?: { url: string };
    blockModel?: { url: string };
    cubeModel?: { url: string };
    boundaryModel?: { url: string };
    progressiveModel?: { url: string; default?: boolean };
}

export function validateManifest(manifest: TerrainManifest, mapKey: string): void {
    if (
        manifest.version !== 2 ||
        manifest.mapKey !== mapKey ||
        manifest.heightUnits !== 'centimeters' ||
        ![
            manifest.originX,
            manifest.originY,
            manifest.maxX,
            manifest.maxY,
            manifest.minZ,
            manifest.maxZ,
        ].every(Number.isFinite) ||
        manifest.originX >= manifest.maxX ||
        manifest.originY >= manifest.maxY ||
        manifest.minZ >= manifest.maxZ ||
        !Array.isArray(manifest.warnings) ||
        !manifest.warnings.every((warning) => typeof warning === 'string') ||
        'tiles' in manifest ||
        'spacing' in manifest ||
        (manifest.progressiveModel?.default !== undefined &&
            typeof manifest.progressiveModel.default !== 'boolean') ||
        [manifest.worldModel, manifest.blockModel, manifest.cubeModel, manifest.progressiveModel, manifest.boundaryModel].some(
            (link) =>
                link !== undefined &&
                (link === null || typeof link.url !== 'string' || !link.url.trim()),
        )
    )
        throw new Error(`Invalid 3D map metadata for ${mapKey}.`);
}
