import { boundedResponse } from './bounded-response.js';
import { decodeVoxelRuns, type VoxelDescriptor, type VoxelMesh, type VoxelMesher } from './voxel-runs.js';
import type { WorldBounds } from './world-model.js';

export class VoxelWorker implements VoxelMesher {
    private worker?: Worker;
    private id = 0;
    private active?: number;
    private jobs = new Map<number, {
        reject: (error: Error) => void; resolve: (mesh: VoxelMesh) => void; cleanup: () => void;
        bytes: ArrayBuffer; bounds: WorldBounds; count: number;
    }>();
    private failure?: Error;
    private fail(error: Error): void {
        this.failure = error;
        this.worker?.terminate();
        this.active = undefined;
        for (const job of [...this.jobs.values()]) { job.cleanup(); job.reject(error); }
    }
    private start(): Worker {
        const worker = new Worker(new URL('./voxel-worker.js', document.baseURI), { type: 'module' });
        worker.addEventListener('error', event => {
            this.fail(new Error(`Voxel worker failed: ${event.message}`));
        });
        worker.addEventListener('messageerror', () => this.fail(new Error('Voxel worker response could not be decoded.')));
        worker.addEventListener('message', (event: MessageEvent<{ id: number; mesh?: VoxelMesh; error?: string }>) => {
            const job = this.jobs.get(event.data.id);
            if (!job || event.data.id !== this.active) return;
            this.active = undefined;
            job.cleanup();
            if (event.data.error) job.reject(new Error(event.data.error));
            else if (event.data.mesh) job.resolve(event.data.mesh);
            else job.reject(new Error('Invalid voxel worker response.'));
            this.pump();
        });
        return worker;
    }
    private pump(): void {
        if (this.active !== undefined || this.failure || !this.jobs.size) return;
        const [id, job] = this.jobs.entries().next().value!;
        try {
            this.worker ??= this.start();
            this.active = id;
            this.worker.postMessage({ id, bytes: job.bytes, bounds: job.bounds, count: job.count }, [job.bytes]);
        } catch (error) {
            this.fail(new Error(`Could not start voxel worker: ${error instanceof Error ? error.message : String(error)}`));
        }
    }
    mesh(bytes: ArrayBuffer, bounds: WorldBounds, count: number, signal: AbortSignal): Promise<VoxelMesh> {
        if (this.failure) return Promise.reject(this.failure);
        signal.throwIfAborted();
        if (this.jobs.size >= 2) return Promise.reject(new Error('Voxel worker queue exceeds two chunks.'));
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                signal.removeEventListener('abort', abort);
                this.jobs.delete(id);
            };
            const abort = () => {
                if (this.active === id) {
                    this.worker?.terminate();
                    this.worker = undefined;
                    this.active = undefined;
                }
                cleanup();
                reject(signal.reason);
                this.pump();
            };
            this.jobs.set(id, { reject, resolve, cleanup, bytes, bounds, count });
            signal.addEventListener('abort', abort, { once: true });
            this.pump();
        });
    }
    dispose(): void {
        this.failure = new Error('Voxel worker is disposed.');
        this.worker?.terminate();
        for (const job of [...this.jobs.values()]) { job.cleanup(); job.reject(new DOMException('Voxel layer cleared.', 'AbortError')); }
        this.jobs.clear();
    }
}

export class VoxelBundles {
    private entries = new Map<string, { bytes: ArrayBuffer; descriptor: VoxelDescriptor }>();
    private pending = new Map<string, { promise: Promise<ArrayBuffer>; controller: AbortController; descriptor: VoxelDescriptor; users: number }>();
    private bytes = 0;
    private disposed = false;
    constructor(private request: typeof fetch, private budget: number) {}
    get residentBytes(): number { return this.bytes; }
    setBudget(bytes: number): void {
        this.budget = bytes;
        this.evict(0);
    }
    clear(): void {
        this.disposed = true;
        for (const entry of this.pending.values()) entry.controller.abort();
        this.pending.clear();
        this.entries.clear();
        this.bytes = 0;
    }
    private evict(incoming: number): void {
        while (this.bytes + incoming > this.budget && this.entries.size) {
            const key = this.entries.keys().next().value!;
            this.bytes -= this.entries.get(key)!.bytes.byteLength;
            this.entries.delete(key);
        }
    }
    async get(url: URL, descriptor: VoxelDescriptor, bounds: WorldBounds, signal: AbortSignal): Promise<ArrayBuffer> {
        signal.throwIfAborted();
        if (this.disposed) throw new Error('Voxel cache is disposed.');
        if (descriptor.bundleBytes > this.budget) throw new Error('Voxel bundle exceeds the selected cache budget.');
        const key = url.href;
        const known = this.entries.get(key)?.descriptor ?? this.pending.get(key)?.descriptor;
        if (known && (known.sha256 !== descriptor.sha256 || known.bundleBytes !== descriptor.bundleBytes))
            throw new Error('Conflicting voxel bundle descriptors.');
        let bytes = this.entries.get(key)?.bytes;
        if (bytes) {
            const entry = this.entries.get(key)!;
            this.entries.delete(key); this.entries.set(key, entry);
        } else {
            let entry = this.pending.get(key);
            if (!entry) {
                if (this.pending.size >= 4) throw new Error('Voxel bundle requests exceed the four-request limit.');
                const controller = new AbortController();
                const promise = (async () => {
                    const result = await boundedResponse(await this.request(url, { signal: controller.signal }),
                        descriptor.bundleBytes, controller.signal, 'Voxel bundle');
                    controller.signal.throwIfAborted();
                    if (result.byteLength !== descriptor.bundleBytes) throw new Error('Wrong voxel bundle length.');
                    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', result))]
                        .map(b => b.toString(16).padStart(2, '0')).join('');
                    controller.signal.throwIfAborted();
                    if (hash !== descriptor.sha256) throw new Error('Voxel bundle SHA-256 mismatch.');
                    this.evict(result.byteLength);
                    if (result.byteLength <= this.budget) {
                        this.entries.set(key, { bytes: result, descriptor });
                        this.bytes += result.byteLength;
                    }
                    return result;
                })();
                entry = { promise, controller, descriptor, users: 0 };
                this.pending.set(key, entry);
                const finished = () => { if (this.pending.get(key) === entry) this.pending.delete(key); };
                void promise.then(finished, finished);
            }
            entry.users++;
            try {
                bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
                    const abort = () => reject(signal.reason);
                    signal.addEventListener('abort', abort, { once: true });
                    void entry.promise.then(result => { signal.removeEventListener('abort', abort); resolve(result); },
                        error => { signal.removeEventListener('abort', abort); reject(error); });
                });
            } finally {
                if (--entry.users === 0 && this.pending.get(key) === entry) {
                    this.pending.delete(key);
                    entry.controller.abort();
                }
            }
        }
        signal.throwIfAborted();
        const chunk = bytes.slice(descriptor.offset, descriptor.offset + descriptor.length);
        decodeVoxelRuns(chunk, bounds, descriptor.count);
        return chunk;
    }
}
