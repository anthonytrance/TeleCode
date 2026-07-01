export function parseJsonFileText<T>(raw: string): T {
  return JSON.parse(stripUtf8Bom(raw)) as T;
}

function stripUtf8Bom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}
