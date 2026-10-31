import type { MapResource } from './data/types.js';

interface Bounds {
    originX: number;
    originY: number;
    maxX: number;
    maxY: number;
}

export function resourcePositions(points: MapResource['points'], bounds: Bounds): Float32Array {
    const centerX = (bounds.originX + bounds.maxX) / 2;
    const centerY = (bounds.originY + bounds.maxY) / 2;
    if (![centerX, centerY].every(Number.isFinite)) {
        throw new Error('Invalid terrain bounds for resources.');
    }
    const positions = new Float32Array(points.length * 3);
    points.forEach((point, index) => {
        if (point.length !== 3 || !point.every(Number.isFinite)) {
            throw new Error(`Invalid resource XYZ at index ${index}.`);
        }
        positions.set(
            [(point[0] - centerX) / 100, point[2] / 100, (point[1] - centerY) / 100],
            index * 3,
        );
    });
    return positions;
}
