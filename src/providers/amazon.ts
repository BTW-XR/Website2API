import * as cheerio from 'cheerio';
import { fetchText } from '../core/fetch-page.js';
import { ExtractError, type ExtractSuccess, unsupported } from '../core/types.js';

export interface AmazonProductCard {
  title: string;
  price: string | null;
  rating: string | null;
  reviewCount: string | null;
  url: string | null;
  image: string | null;
}

export interface AmazonDetailPair {
  label: string;
  value: string;
}

export interface AmazonReviewSignal {
  rating: string | null;
  title: string | null;
  body: string | null;
}

export interface AmazonSearchData {
  pageTitle: string;
  resultCount: string | null;
  products: AmazonProductCard[];
}

export interface AmazonProductData {
  asin: string;
  pageTitle: string;
  title: string;
  price: string | null;
  rating: string | null;
  reviewCount: string | null;
  availability: string | null;
  images: string[];
  featureBullets: string[];
  details: AmazonDetailPair[];
  reviewSignals: AmazonReviewSignal[];
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripEmbeddedScriptText(value: string): string {
  return cleanText(value)
    .replace(/\s*var\s+[\s\S]*$/i, '')
    .replace(/\s*\{["'][\s\S]*$/i, '')
    .trim();
}

function pickText($: cheerio.CheerioAPI, selector: string): string | null {
  return cleanText($(selector).first().text()) || null;
}

function validateAmazonUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    unsupported('Invalid Amazon URL');
  }

  if (parsed.hostname !== 'amazon.com' && parsed.hostname !== 'www.amazon.com') {
    unsupported('Only amazon.com URLs are supported');
  }

  parsed.protocol = 'https:';
  parsed.hostname = 'www.amazon.com';
  return parsed;
}

export function canHandleAmazonUrl(url: URL): 'search' | 'product' | null {
  if (url.hostname !== 'amazon.com' && url.hostname !== 'www.amazon.com') return null;
  if (url.pathname === '/s' && url.searchParams.get('k')) return 'search';
  if (/\/(?:dp|gp\/product)\/[A-Z0-9]{10}(?:[/?]|$)/i.test(url.pathname)) {
    return 'product';
  }
  return null;
}

function amazonSearchUrl(input: { query?: unknown; url?: unknown }): URL {
  if (typeof input.query === 'string' && input.query.trim()) {
    const url = new URL('https://www.amazon.com/s');
    url.searchParams.set('k', input.query.trim());
    return url;
  }

  if (typeof input.url !== 'string' || !input.url.trim()) {
    unsupported('Amazon search requires a query or search URL');
  }

  const url = validateAmazonUrl(input.url);
  if (url.pathname !== '/s' || !url.searchParams.get('k')) {
    unsupported('Amazon search URL must look like https://www.amazon.com/s?k=cat');
  }
  return url;
}

function amazonProductUrl(input: { url?: unknown }): { asin: string; url: URL } {
  if (typeof input.url !== 'string' || !input.url.trim()) {
    unsupported('Amazon product extraction requires a product URL');
  }

  const url = validateAmazonUrl(input.url);
  const match = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
  if (!match?.[1]) {
    unsupported('Amazon product URL must contain /dp/{ASIN} or /gp/product/{ASIN}');
  }
  return { asin: match[1].toUpperCase(), url };
}

function assertNotCaptcha($: cheerio.CheerioAPI): void {
  const bodyText = cleanText($('body').text());
  if (/Enter the characters you see below|Sorry, we just need to make sure/i.test(bodyText)) {
    throw new ExtractError('REMOTE_BLOCKED', 'Amazon returned a verification page', 502);
  }
}

function parseProducts($: cheerio.CheerioAPI, sourceUrl: string): AmazonProductCard[] {
  return $('[data-component-type="s-search-result"]')
    .map((_, element) => {
      const card = $(element);
      const title = cleanText(card.find('h2 span').first().text());
      const productUrl = card
        .find('a[href*="/dp/"]')
        .map((__, link) => $(link).attr('href'))
        .get()
        .find((href) => href && !href.includes('#customerReviews'));
      const wholePrice = card
        .find('.a-price-whole')
        .first()
        .text()
        .replace(/[^\d]/g, '');
      const fractionPrice = card
        .find('.a-price-fraction')
        .first()
        .text()
        .replace(/[^\d]/g, '');
      const price =
        wholePrice || fractionPrice
          ? `$${wholePrice}${fractionPrice ? `.${fractionPrice}` : ''}`
          : null;
      const reviewCountFromLabel = card
        .find('a[href*="#customerReviews"], a[aria-label*="ratings"]')
        .map((__, link) => $(link).attr('aria-label') ?? $(link).text())
        .get()
        .find((text) => /\bratings?\b/i.test(text))
        ?.replace(/\s+/g, ' ')
        .trim();
      const reviewCountFromText = cleanText(
        card.find('a[href*="#customerReviews"] span').first().text(),
      );

      return {
        title,
        price,
        rating: cleanText(card.find('.a-icon-alt').first().text()) || null,
        reviewCount: reviewCountFromLabel || reviewCountFromText || null,
        url: productUrl ? new URL(productUrl, sourceUrl).href : null,
        image: card.find('img.s-image').attr('src') ?? null,
      };
    })
    .get()
    .filter((product) => product.title)
    .slice(0, 10);
}

function parseImages($: cheerio.CheerioAPI): string[] {
  const urls: string[] = [];
  const dynamicImage = $('#landingImage').attr('data-a-dynamic-image');
  if (dynamicImage) {
    try {
      urls.push(...Object.keys(JSON.parse(dynamicImage) as Record<string, unknown>));
    } catch {
      // Ignore malformed embedded image JSON.
    }
  }

  urls.push(
    ...[
      $('#landingImage').attr('data-old-hires'),
      $('#landingImage').attr('src'),
      ...$('#altImages img')
        .map((_, image) => $(image).attr('src'))
        .get(),
      ...$('#imgTagWrapperId img')
        .map((_, image) => $(image).attr('src'))
        .get(),
    ].filter((src): src is string => Boolean(src)),
  );

  return [...new Set(urls)].slice(0, 10);
}

function parseDetails($: cheerio.CheerioAPI, asin: string): AmazonDetailPair[] {
  const details = new Map<string, string>();
  $(
    '#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr',
  ).each((_, row) => {
    const label = stripEmbeddedScriptText($(row).find('th').text()).replace(/:$/, '');
    const value = stripEmbeddedScriptText($(row).find('td').text());
    if (label && value) details.set(label, value);
  });

  $('#detailBullets_feature_div li').each((_, item) => {
    const text = stripEmbeddedScriptText($(item).text());
    const [rawLabel, ...rawValue] = text.split(/\s*:\s*/);
    const label = cleanText(rawLabel?.replace(/[‏‎]/g, '') ?? '').replace(/:$/, '');
    const value = cleanText(rawValue.join(':').replace(/[‏‎]/g, ''));
    if (label && value && !details.has(label)) details.set(label, value);
  });

  if (!details.has('ASIN')) details.set('ASIN', asin);
  return [...details.entries()].map(([label, value]) => ({ label, value })).slice(0, 14);
}

function parseFeatureBullets($: cheerio.CheerioAPI): string[] {
  return $('#feature-bullets li span.a-list-item')
    .map((_, element) => stripEmbeddedScriptText($(element).text()))
    .get()
    .filter((text) => text && !/Make sure this fits/i.test(text))
    .slice(0, 8);
}

function parseReviewSignals($: cheerio.CheerioAPI): AmazonReviewSignal[] {
  return $('[data-hook="review"]')
    .map((_, review) => {
      const root = $(review);
      return {
        rating:
          cleanText(
            root
              .find(
                '[data-hook="review-star-rating"] .a-icon-alt, [data-hook="cmps-review-star-rating"] .a-icon-alt',
              )
              .first()
              .text(),
          ) || null,
        title: stripEmbeddedScriptText(root.find('[data-hook="review-title"]').text()) || null,
        body: stripEmbeddedScriptText(root.find('[data-hook="review-body"]').text()) || null,
      };
    })
    .get()
    .filter((review) => review.title || review.body)
    .slice(0, 5);
}

export async function extractAmazonSearch(input: {
  query?: unknown;
  url?: unknown;
}): Promise<ExtractSuccess<AmazonSearchData>> {
  const url = amazonSearchUrl(input);
  const $ = cheerio.load(await fetchText(url));
  assertNotCaptcha($);

  const products = parseProducts($, url.href);
  if (products.length === 0) {
    throw new ExtractError('PARSE_FAILED', 'No Amazon products were found', 502);
  }

  return {
    ok: true,
    provider: 'amazon',
    type: 'search',
    sourceUrl: url.href,
    data: {
      pageTitle: $('title').text().trim(),
      resultCount:
        $('[data-component-type="s-result-info-bar"]')
          .text()
          .replace(/\s+/g, ' ')
          .trim()
          .match(/^\s*(.*?results for "[^"]+")/)?.[1] ?? null,
      products,
    },
  };
}

export async function extractAmazonProduct(input: {
  url?: unknown;
}): Promise<ExtractSuccess<AmazonProductData>> {
  const { asin, url } = amazonProductUrl(input);
  const $ = cheerio.load(await fetchText(url));
  assertNotCaptcha($);

  const title = pickText($, '#productTitle');
  if (!title) throw new ExtractError('PARSE_FAILED', 'No Amazon product title was found', 502);

  return {
    ok: true,
    provider: 'amazon',
    type: 'product',
    sourceUrl: url.href,
    data: {
      asin,
      pageTitle: $('title').text().trim(),
      title,
      price:
        pickText($, '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen') ??
        pickText($, '.a-price .a-offscreen'),
      rating:
        pickText($, '#acrPopover .a-icon-alt') ??
        pickText($, '.reviewCountTextLinkedHistogram .a-icon-alt'),
      reviewCount: pickText($, '#acrCustomerReviewText'),
      availability: stripEmbeddedScriptText($('#availability').first().text()) || null,
      images: parseImages($),
      featureBullets: parseFeatureBullets($),
      details: parseDetails($, asin),
      reviewSignals: parseReviewSignals($),
    },
  };
}
