import type { MapInfo } from './data/types.js';

const canonKeys = [
    'TheIsland_WP',
    'ScorchedEarth_WP',
    'Aberration_WP',
    'Extinction_WP',
    'LostColony_WP',
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
    const key = url.searchParams.get('map') ?? maps[0]?.key;
    if (key === undefined) throw new Error('No maps are available.');
    if (!maps.some((map) => map.key === key)) throw new Error(`Unknown map ${key}`);
    return key;
}

export function mapUrl(url: URL, key: string): URL {
    const result = new URL(url);
    result.searchParams.set('map', key);
    return result;
}
