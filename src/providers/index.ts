import {
  canHandleAmazonUrl,
  extractAmazonProduct,
  extractAmazonSearch,
} from './amazon.js';
import {
  canHandleYouTubeUrl,
  extractYouTubeSearch,
  extractYouTubeVideo,
} from './youtube.js';
import {
  canHandleGoogleFlightsUrl,
  extractGoogleFlightsSearch,
  extractGoogleFlightsStructuredSearch,
} from './google-flights.js';
import { type ExtractRequest, type ExtractSuccess, unsupported } from '../core/types.js';

function parseUrl(input: unknown): URL | null {
  if (typeof input !== 'string' || !input.trim()) return null;
  try {
    return new URL(input.trim());
  } catch {
    return null;
  }
}

export async function extract(input: ExtractRequest): Promise<ExtractSuccess> {
  if (input.provider === 'amazon') {
    if (input.type === 'search') return extractAmazonSearch(input);
    if (input.type === 'product') return extractAmazonProduct(input);
    unsupported('Amazon requires type "search" or "product"');
  }

  if (input.provider === 'youtube') {
    if (input.type === 'search') return extractYouTubeSearch(input);
    if (input.type === 'video') return extractYouTubeVideo(input);
    unsupported('YouTube requires type "search" or "video"');
  }

  if (input.provider === 'google-flights') {
    if (input.type === 'search') {
      return typeof input.url === 'string' && input.url.trim()
        ? extractGoogleFlightsSearch(input)
        : extractGoogleFlightsStructuredSearch(input);
    }
    unsupported('Google Flights requires type "search" and either a search URL or structured criteria');
  }

  const url = parseUrl(input.url);
  if (!url) unsupported('Provide a supported URL, or provider/type/query');

  const amazonType = canHandleAmazonUrl(url);
  if (amazonType === 'search') return extractAmazonSearch({ url: url.href });
  if (amazonType === 'product') return extractAmazonProduct({ url: url.href });

  const youtubeType = canHandleYouTubeUrl(url);
  if (youtubeType === 'search') return extractYouTubeSearch({ url: url.href });
  if (youtubeType === 'video') return extractYouTubeVideo({ url: url.href });

  const googleFlightsType = canHandleGoogleFlightsUrl(url);
  if (googleFlightsType === 'search') return extractGoogleFlightsSearch({ url: url.href });
  if (googleFlightsType === 'booking') {
    unsupported('Google Flights booking detail pages are not supported yet');
  }

  unsupported('Unsupported URL');
}
