export async function freshJson<T>(url: string, signal: AbortSignal): Promise<T> {
    // Export discovery must not reuse metadata from before an optional asset was published.
    const response = await fetch(url, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json() as Promise<T>;
}
