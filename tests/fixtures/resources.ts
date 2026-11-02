import type { MapResource } from '../../src/data/types.js';

export const metalResource: MapResource = {
    resourceType: 'Metal',
    points: Array.from({ length: 64 * 80 }, (_, i) => {
        const group = Math.floor(i / 80);
        const local = i % 80;
        return [
            (group % 8) * 40000 + (local % 5) * 100,
            Math.floor(group / 8) * 40000 + (Math.floor(local / 5) % 4) * 100,
            ((group % 3) - 1) * 6000 + Math.floor(local / 20) * 100,
        ];
    }),
};
