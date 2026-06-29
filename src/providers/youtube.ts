import * as cheerio from 'cheerio';
import { collectByKey, extractJsonAfter, getPath, isRecord, type JsonObject } from '../core/extract-json.js';
import { fetchText } from '../core/fetch-page.js';
import { ExtractError, type ExtractSuccess, unsupported } from '../core/types.js';

export interface YouTubeVideoCard {
  videoId: string;
  title: string;
  channel: string | null;
  views: string | null;
  published: string | null;
  duration: string | null;
  thumbnail: string | null;
  description: string | null;
  url: string;
}

export interface YouTubeComment {
  author: string | null;
  content: string;
  published: string | null;
  likeCount: string | null;
  avatar: string | null;
}

export interface YouTubeSearchData {
  query: string;
  videos: YouTubeVideoCard[];
}

export interface YouTubeVideoData {
  videoId: string;
  embedUrl: string;
  title: string;
  channel: string | null;
  views: string | null;
  subscriberCount: string | null;
  lengthSeconds: string | null;
  description: string | null;
  thumbnails: string[];
  relatedVideos: YouTubeVideoCard[];
  comments: YouTubeComment[];
}

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function extractInitialJson($: cheerio.CheerioAPI, marker: string): JsonObject {
  for (const script of $('script').toArray()) {
    const content = $(script).html() ?? '';
    if (!content.includes(marker)) continue;
    const parsed = extractJsonAfter(content, marker);
    if (isRecord(parsed)) return parsed;
  }

  throw new ExtractError('PARSE_FAILED', 'YouTube page data was not found', 502);
}

function ytText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value['simpleText'] === 'string') return cleanText(value['simpleText']);
  if (Array.isArray(value['runs'])) {
    const text = value['runs']
      .map((run) => (isRecord(run) && typeof run['text'] === 'string' ? run['text'] : ''))
      .join('');
    return cleanText(text) || null;
  }
  return null;
}

function thumbnailUrl(value: unknown): string | null {
  const thumbnails = getPath(value, ['thumbnail', 'thumbnails']);
  if (!Array.isArray(thumbnails)) return null;
  const last = thumbnails[thumbnails.length - 1];
  return isRecord(last) && typeof last['url'] === 'string' ? last['url'] : null;
}

const YOUTUBE_API_HEADERS = {
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'content-type': 'application/json',
  origin: 'https://www.youtube.com',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

export function canHandleYouTubeUrl(url: URL): 'search' | 'video' | null {
  if (url.hostname === 'youtu.be') return /^[\w-]{11}$/.test(url.pathname.slice(1)) ? 'video' : null;
  if (url.hostname !== 'youtube.com' && url.hostname !== 'www.youtube.com') return null;
  if (url.pathname === '/results' && url.searchParams.get('search_query')) return 'search';
  if (url.pathname === '/watch' && url.searchParams.get('v')) return 'video';
  if (/^\/(?:embed|shorts)\/[\w-]{11}/.test(url.pathname)) return 'video';
  return null;
}

function youtubeSearchUrl(input: { query?: unknown; url?: unknown }): { query: string; url: URL } {
  if (typeof input.query === 'string' && input.query.trim()) {
    const url = new URL('https://www.youtube.com/results');
    url.searchParams.set('search_query', input.query.trim());
    return { query: input.query.trim(), url };
  }

  if (typeof input.url !== 'string' || !input.url.trim()) {
    unsupported('YouTube search requires a query or search URL');
  }

  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    unsupported('Invalid YouTube search URL');
  }

  if (url.hostname !== 'youtube.com' && url.hostname !== 'www.youtube.com') {
    unsupported('Only youtube.com search URLs are supported');
  }

  const query = url.searchParams.get('search_query');
  if (url.pathname !== '/results' || !query) {
    unsupported('YouTube search URL must look like https://www.youtube.com/results?search_query=atlanta');
  }

  url.protocol = 'https:';
  url.hostname = 'www.youtube.com';
  return { query, url };
}

function youtubeVideoUrl(input: { videoId?: unknown; url?: unknown }): { videoId: string; url: URL } {
  if (typeof input.videoId === 'string' && /^[\w-]{11}$/.test(input.videoId.trim())) {
    const videoId = input.videoId.trim();
    return { videoId, url: new URL(`https://www.youtube.com/watch?v=${videoId}`) };
  }

  if (typeof input.url !== 'string' || !input.url.trim()) {
    unsupported('YouTube video extraction requires a video URL or videoId');
  }

  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    unsupported('Invalid YouTube video URL');
  }

  let videoId: string | null = null;
  if (url.hostname === 'youtu.be') {
    videoId = url.pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (url.hostname === 'youtube.com' || url.hostname === 'www.youtube.com') {
    videoId =
      url.searchParams.get('v') ??
      url.pathname.match(/\/(?:embed|shorts)\/([\w-]{11})/)?.[1] ??
      null;
  }

  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    unsupported('Invalid YouTube video URL or videoId');
  }

  return { videoId, url: new URL(`https://www.youtube.com/watch?v=${videoId}`) };
}

function parseVideoRenderer(renderer: unknown): YouTubeVideoCard | null {
  if (!isRecord(renderer) || typeof renderer['videoId'] !== 'string') return null;
  const title = ytText(renderer['title']);
  if (!title) return null;

  const videoId = renderer['videoId'];
  return {
    videoId,
    title,
    channel:
      ytText(renderer['ownerText']) ??
      ytText(renderer['shortBylineText']) ??
      ytText(renderer['longBylineText']),
    views: ytText(renderer['viewCountText']) ?? ytText(renderer['shortViewCountText']),
    published: ytText(renderer['publishedTimeText']),
    duration: ytText(renderer['lengthText']),
    thumbnail: thumbnailUrl(renderer),
    description: ytText(getPath(renderer, ['detailedMetadataSnippets', 0, 'snippetText'])),
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

function parseVideosFromData(
  data: unknown,
  key: string,
  limit: number,
  excludeId?: string,
): YouTubeVideoCard[] {
  const seen = new Set<string>();
  const videos: YouTubeVideoCard[] = [];

  for (const renderer of collectByKey(data, key)) {
    const video = parseVideoRenderer(renderer);
    if (!video || video.videoId === excludeId || seen.has(video.videoId)) continue;
    seen.add(video.videoId);
    videos.push(video);
    if (videos.length >= limit) break;
  }

  return videos;
}

function mergeVideos(
  videos: YouTubeVideoCard[],
  limit: number,
  excludeId?: string,
): YouTubeVideoCard[] {
  const seen = new Set<string>();
  const merged: YouTubeVideoCard[] = [];
  for (const video of videos) {
    if (video.videoId === excludeId || seen.has(video.videoId)) continue;
    seen.add(video.videoId);
    merged.push(video);
    if (merged.length >= limit) break;
  }
  return merged;
}

function extractInnertubeConfig($: cheerio.CheerioAPI): {
  apiKey: string | null;
  clientVersion: string | null;
  visitorData: string | null;
} {
  const scripts = $('script')
    .map((_, script) => $(script).html() ?? '')
    .get()
    .join('\n');

  return {
    apiKey: scripts.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] ?? null,
    clientVersion: scripts.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] ?? null,
    visitorData: scripts.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] ?? null,
  };
}

function commentContinuationTokens(data: unknown): string[] {
  return collectByKey(data, 'continuationEndpoint')
    .map((endpoint) => getPath(endpoint, ['continuationCommand', 'token']))
    .filter((token): token is string => typeof token === 'string')
    .filter((token) => token.includes('Eg0S') || token.includes('comments'))
    .slice(0, 4);
}

function parseCommentEntities(data: unknown, limit: number): YouTubeComment[] {
  const comments: YouTubeComment[] = [];

  for (const mutation of collectByKey(data, 'commentEntityPayload')) {
    if (!isRecord(mutation)) continue;
    const properties = mutation['properties'];
    const author = mutation['author'];
    const toolbar = mutation['toolbar'];
    const avatarSources = getPath(mutation, ['avatar', 'image', 'sources']);
    const content = getPath(properties, ['content', 'content']);
    if (typeof content !== 'string' || cleanText(content) === '') continue;

    const lastAvatar =
      Array.isArray(avatarSources) && avatarSources.length > 0
        ? avatarSources[avatarSources.length - 1]
        : null;

    comments.push({
      author:
        (isRecord(author) && typeof author['displayName'] === 'string'
          ? author['displayName']
          : null) ??
        (isRecord(properties) && typeof properties['authorButtonA11y'] === 'string'
          ? properties['authorButtonA11y']
          : null),
      content: cleanText(content),
      published:
        isRecord(properties) && typeof properties['publishedTime'] === 'string'
          ? properties['publishedTime']
          : null,
      likeCount:
        (isRecord(toolbar) && typeof toolbar['likeCountNotliked'] === 'string'
          ? `${toolbar['likeCountNotliked']} likes`
          : null) ??
        (isRecord(toolbar) && typeof toolbar['likeCountA11y'] === 'string'
          ? toolbar['likeCountA11y']
          : null),
      avatar: isRecord(lastAvatar) && typeof lastAvatar['url'] === 'string' ? lastAvatar['url'] : null,
    });

    if (comments.length >= limit) break;
  }

  return comments;
}

async function fetchComments(
  $: cheerio.CheerioAPI,
  initialData: JsonObject,
  watchUrl: string,
): Promise<YouTubeComment[]> {
  const config = extractInnertubeConfig($);
  if (!config.apiKey || !config.clientVersion) return [];

  for (const token of commentContinuationTokens(initialData)) {
    try {
      const response = await fetch(
        `https://www.youtube.com/youtubei/v1/next?key=${config.apiKey}`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(8000),
          headers: {
            ...YOUTUBE_API_HEADERS,
            referer: watchUrl,
          },
          body: JSON.stringify({
            context: {
              client: {
                clientName: 'WEB',
                clientVersion: config.clientVersion,
                hl: 'en',
                gl: 'US',
                visitorData: config.visitorData ?? undefined,
              },
            },
            continuation: token,
          }),
        },
      );
      if (!response.ok) continue;
      const comments = parseCommentEntities((await response.json()) as unknown, 8);
      if (comments.length > 0) return comments;
    } catch {
      continue;
    }
  }

  return [];
}

function parseThumbnails(playerResponse: JsonObject): string[] {
  const thumbnails = getPath(playerResponse, ['videoDetails', 'thumbnail', 'thumbnails']);
  if (!Array.isArray(thumbnails)) return [];
  return thumbnails
    .map((thumbnail) =>
      isRecord(thumbnail) && typeof thumbnail['url'] === 'string' ? thumbnail['url'] : '',
    )
    .filter(Boolean)
    .slice(-4);
}

async function relatedVideoFallback(
  title: string,
  channel: string | null,
  excludeId: string,
): Promise<YouTubeVideoCard[]> {
  try {
    const data = await extractYouTubeSearch({ query: [title, channel].filter(Boolean).join(' ') });
    return data.data.videos.filter((video) => video.videoId !== excludeId).slice(0, 8);
  } catch {
    return [];
  }
}

export async function extractYouTubeSearch(input: {
  query?: unknown;
  url?: unknown;
}): Promise<ExtractSuccess<YouTubeSearchData>> {
  const { query, url } = youtubeSearchUrl(input);
  const $ = cheerio.load(await fetchText(url));
  const initialData = extractInitialJson($, 'ytInitialData');
  const videos = parseVideosFromData(initialData, 'videoRenderer', 12);
  if (videos.length === 0) {
    throw new ExtractError('PARSE_FAILED', 'No YouTube search results were found', 502);
  }

  return {
    ok: true,
    provider: 'youtube',
    type: 'search',
    sourceUrl: url.href,
    data: { query, videos },
  };
}

export async function extractYouTubeVideo(input: {
  videoId?: unknown;
  url?: unknown;
}): Promise<ExtractSuccess<YouTubeVideoData>> {
  const { videoId, url } = youtubeVideoUrl(input);
  const $ = cheerio.load(await fetchText(url));
  const initialData = extractInitialJson($, 'ytInitialData');
  const playerResponse = extractInitialJson($, 'ytInitialPlayerResponse');
  const videoDetails = getPath(playerResponse, ['videoDetails']);
  if (!isRecord(videoDetails) || typeof videoDetails['title'] !== 'string') {
    throw new ExtractError('PARSE_FAILED', 'No YouTube video details were found', 502);
  }

  const primaryInfo = collectByKey(initialData, 'videoPrimaryInfoRenderer')[0];
  const secondaryInfo = collectByKey(initialData, 'videoSecondaryInfoRenderer')[0];
  const channel =
    (typeof videoDetails['author'] === 'string' ? videoDetails['author'] : null) ??
    ytText(getPath(secondaryInfo, ['owner', 'videoOwnerRenderer', 'title']));
  const relatedVideos = mergeVideos(
    [
      ...parseVideosFromData(initialData, 'compactVideoRenderer', 8, videoId),
      ...parseVideosFromData(initialData, 'videoRenderer', 8, videoId),
    ],
    8,
    videoId,
  );
  const relatedFallback =
    relatedVideos.length > 0
      ? []
      : await relatedVideoFallback(videoDetails['title'], channel, videoId);

  return {
    ok: true,
    provider: 'youtube',
    type: 'video',
    sourceUrl: url.href,
    data: {
      videoId,
      embedUrl: `https://www.youtube.com/embed/${videoId}`,
      title: videoDetails['title'],
      channel,
      views: ytText(getPath(primaryInfo, ['viewCount', 'videoViewCountRenderer', 'viewCount'])),
      subscriberCount: ytText(
        getPath(secondaryInfo, ['owner', 'videoOwnerRenderer', 'subscriberCountText']),
      ),
      lengthSeconds:
        typeof videoDetails['lengthSeconds'] === 'string' ? videoDetails['lengthSeconds'] : null,
      description:
        typeof videoDetails['shortDescription'] === 'string'
          ? videoDetails['shortDescription']
          : null,
      thumbnails: parseThumbnails(playerResponse),
      relatedVideos: mergeVideos([...relatedVideos, ...relatedFallback], 8, videoId),
      comments: await fetchComments($, initialData, url.href),
    },
  };
}
