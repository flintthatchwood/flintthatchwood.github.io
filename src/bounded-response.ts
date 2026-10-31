export async function boundedResponse(
    response: Response,
    limit: number,
    signal: AbortSignal,
    label = 'Walkability',
): Promise<ArrayBuffer> {
    if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
    if (!response.body) throw new Error(`${label} response has no body.`);
    const reader = response.body.getReader();
    const data = new Uint8Array(limit);
    let size = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            if (size + value.length > limit)
                throw new Error(`${label} response exceeds expected length/budget.`);
            data.set(value, size);
            size += value.length;
        }
        return size === limit ? data.buffer : data.buffer.slice(0, size);
    } finally {
        await reader.cancel();
    }
}
