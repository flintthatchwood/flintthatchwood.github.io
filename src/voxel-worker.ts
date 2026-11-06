import { meshVoxelRuns } from './voxel-runs.js';
import type { WorldBounds } from './world-model.js';

self.onmessage = (event: MessageEvent<{ id: number; bytes: ArrayBuffer; bounds: WorldBounds; count: number }>) => {
    const { id, bytes, bounds, count } = event.data;
    try {
        const mesh = meshVoxelRuns(bytes, bounds, count);
        self.postMessage({ id, mesh }, { transfer: [mesh.bytes] });
    } catch (error) {
        self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
};
