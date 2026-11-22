import type { MapInfo, SubmapInfo } from './data/types.js';

const canonKeys = [
    'TheIsland_WP',
    'ScorchedEarth_WP',
    'Aberration_WP',
    'Extinction_WP',
    'LostColony_WP',
    'Genesis_WP',
    'Genesis_WP_Main',
    'Genesis_WP_Ocean',
];
const officialDlcKeys = new Set(['Astraeos_WP', 'TheCenter_WP', 'Ragnarok_WP', 'Valguero_WP']);

export function groupedMaps(maps: MapInfo[]): { label: string; maps: MapInfo[] }[] {
    const alphabetical = (a: MapInfo, b: MapInfo) => a.name.localeCompare(b.name, 'en');
    return [
        {
            label: 'Canon',
            maps: canonKeys.flatMap((key) => maps.filter((map) => map.key === key)),
        },
        {
            label: 'Official DLC',
            maps: maps.filter((map) => officialDlcKeys.has(map.key)).sort(alphabetical),
        },
        {
            label: 'Other',
            maps: maps
                .filter((map) => !canonKeys.includes(map.key) && !officialDlcKeys.has(map.key))
                .sort(alphabetical),
        },
    ].filter((group) => group.maps.length > 0);
}

export function orderedMaps(maps: MapInfo[]): MapInfo[] {
    return groupedMaps(maps).flatMap((group) => group.maps);
}

export function mapKeyFromUrl(url: URL, maps: MapInfo[]): string {
    return mapSelectionFromUrl(url, maps).mapKey;
}

export function mapSelectionFromUrl(
    url: URL,
    maps: MapInfo[],
): { mapKey: string; submapKey?: string } {
    const key = url.searchParams.get('map') ?? maps[0]?.key;
    if (key === undefined) throw new Error('No maps are available.');
    const map = maps.find((map) => map.key === key);
    const parent =
        map ?? maps.find((map) => Object.prototype.hasOwnProperty.call(map.aliases ?? {}, key));
    if (!parent) throw new Error(`Unknown map ${key}`);
    return {
        mapKey: parent.key,
        submapKey: url.searchParams.get('submap') ?? (map ? undefined : parent.aliases?.[key]),
    };
}

export function mapUrl(url: URL, key: string, submapKey?: string): URL {
    const result = new URL(url);
    result.searchParams.set('map', key);
    if (submapKey === undefined) result.searchParams.delete('submap');
    else result.searchParams.set('submap', submapKey);
    return result;
}

export function groupedSubmaps(submaps: SubmapInfo[]): { label: string; submaps: SubmapInfo[] }[] {
    return (['Layer', 'Arena', 'Cave'] as const)
        .map((type) => ({
            label: `${type}s`,
            submaps: submaps.filter((submap) => submap.type === type),
        }))
        .filter((group) => group.submaps.length > 0);
}
