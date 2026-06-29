export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function extractJsonAfter(text: string, marker: string): unknown {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;

  const start = text.indexOf('{', markerIndex);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

export function collectByKey(value: unknown, key: string, output: unknown[] = []): unknown[] {
  if (!value || typeof value !== 'object') return output;
  if (isRecord(value) && Object.hasOwn(value, key)) output.push(value[key]);

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectByKey(child, key, output);
  }

  return output;
}

export function getPath(value: unknown, path: Array<string | number>): unknown {
  return path.reduce<unknown>((current, part) => {
    if (typeof part === 'number') return Array.isArray(current) ? current[part] : undefined;
    return isRecord(current) ? current[part] : undefined;
  }, value);
}
