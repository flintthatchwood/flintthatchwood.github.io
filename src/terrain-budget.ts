export const MAX_TERRAIN_TRIANGLES = 4_000_000;

export class TerrainBudget {
    triangles = 1_000_000;
    private previous?: number;
    private samples: number[] = [];
    private readonly minimum: number;
    constructor(baseTriangles: number) {
        this.minimum = Math.max(250_000, baseTriangles);
        this.triangles = Math.max(this.triangles, this.minimum);
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
            this.triangles = Math.min(MAX_TERRAIN_TRIANGLES, Math.floor(this.triangles * 1.2));
    }
}
