const DEFAULT_HEADERS = {
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
};

export interface FetchTextOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export async function fetchText(
  url: URL | string,
  options: FetchTextOptions = {},
): Promise<string> {
  const response = await fetch(url, {
    headers: {
      ...DEFAULT_HEADERS,
      ...options.headers,
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
  });

  if (!response.ok) {
    throw new Error(`Fetch failed with HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
    throw new Error(`Expected HTML but received ${contentType || 'unknown content type'}`);
  }

  return response.text();
}
