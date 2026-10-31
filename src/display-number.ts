export function displayNumber(value: number): string {
    const text = value.toFixed(2);
    return text === '-0.00' ? '0.00' : text;
}
