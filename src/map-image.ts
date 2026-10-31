export type MapImageResult = { kind: 'missing'; status: 404 | 410 } | { kind: 'image'; blob: Blob };

export async function fetchMapImage(
    url: URL,
    signal: AbortSignal,
    request: typeof fetch = fetch,
): Promise<MapImageResult> {
    signal.throwIfAborted();
    const response = await request(url, { signal });
    signal.throwIfAborted();
    if (response.status === 404 || response.status === 410)
        return { kind: 'missing', status: response.status };
    if (!response.ok) throw new Error(`Map image: HTTP ${response.status}`);
    const blob = await response.blob();
    signal.throwIfAborted();
    return { kind: 'image', blob };
}
