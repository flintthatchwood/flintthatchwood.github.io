export const MAX_TERRAIN_TRIANGLES = 4_000_000;
export const WORLD_TRIANGLES = 1_000_000;
export const WORLD_RESIDENT_BYTES = 96 * 1024 * 1024;

export function worldBudget(multiplier = 1) {
    if (![1, 2, 4, 8, 16, 32].includes(multiplier))
        throw new Error('Terrain budget multiplier must be 1, 2, 4, 8, 16 or 32.');
    return {
        triangles: WORLD_TRIANGLES * multiplier,
        bytes: WORLD_RESIDENT_BYTES * multiplier,
        cubeTriangles: Math.max(MAX_TERRAIN_TRIANGLES, WORLD_TRIANGLES * multiplier),
    };
}

export class TerrainBudget {
    triangles = 1_000_000;
    private previous?: number;
    private samples: number[] = [];
    private readonly minimum: number;
    private maximum = MAX_TERRAIN_TRIANGLES;
    constructor(baseTriangles: number, multiplier = 1) {
        this.minimum = Math.max(250_000, baseTriangles);
        this.setMultiplier(multiplier);
    }
    setMultiplier(multiplier: number): void {
        const limits = worldBudget(multiplier);
        this.maximum = limits.cubeTriangles;
        this.triangles = Math.max(limits.triangles, this.minimum);
        this.samples = [];
        this.previous = undefined;
    }
    sample(now: number, needsDetail: boolean): void {
        const elapsed = this.previous === undefined ? 0 : now - this.previous;
        this.previous = now;
        // Ignore first frames and suspended-tab gaps instead of treating them as GPU load.
        if (elapsed <= 0 || elapsed > 250) {
            this.samples = [];
            return;
        }
        this.samples.push(elapsed);
        if (this.samples.length < 120) return;
        const sorted = this.samples.sort((a, b) => a - b);
        const median = sorted[60],
            slow = sorted[108];
        this.samples = [];
        if (median > 23 || slow > 40)
            this.triangles = Math.max(this.minimum, Math.floor(this.triangles * 0.8));
        else if (needsDetail && median < 19 && slow < 25)
            this.triangles = Math.min(this.maximum, Math.floor(this.triangles * 1.2));
    }
}
