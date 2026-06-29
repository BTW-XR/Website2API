import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
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

export interface AmazonImageGalleryItem {
  url: string;
  thumbUrl: string | null;
  variant: string | null;
  altText: string | null;
}

export interface AmazonRichContentSection {
  heading: string | null;
  textBlocks: string[];
  images: string[];
}

export interface AmazonSpecificationGroup {
  title: string;
  items: AmazonDetailPair[];
}

export interface AmazonReviewSignal {
  rating: string | null;
  title: string | null;
  body: string | null;
  author?: string | null;
  date?: string | null;
  helpful?: string | null;
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
  imageGallery: AmazonImageGalleryItem[];
  categoryPath: string[];
  brand: string | null;
  overview: AmazonDetailPair[];
  description: string | null;
  importantInformation: string[];
  featureBullets: string[];
  details: AmazonDetailPair[];
  specificationGroups: AmazonSpecificationGroup[];
  richContentSections: AmazonRichContentSection[];
  reviewSignals: AmazonReviewSignal[];
}

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function stripEmbeddedScriptText(value: string | null | undefined): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function uniqueValues(values: string[], limit = 100): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const text = cleanText(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
    if (output.length >= limit) break;
  }
  return output;
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

function extractBalancedJson(text: string, startIndex: number, opener: '[' | '{'): string | null {
  const closer = opener === '[' ? ']' : '}';
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }

    if (char === opener) {
      depth += 1;
      continue;
    }

    if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function parseJsonArrayAfter(text: string, marker: string): unknown[] {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return [];
  const arrayStart = text.indexOf('[', markerIndex);
  if (arrayStart < 0) return [];
  const rawArray = extractBalancedJson(text, arrayStart, '[');
  if (!rawArray) return [];

  try {
    const parsed = JSON.parse(rawArray) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isRealImageUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  const url = value.trim();
  if (!/^https?:\/\//i.test(url)) return false;
  if (/transparent-pixel|grey-pixel|\/x-locale\/common\/|\/common\/(?:transparent|grey)/i.test(url)) {
    return false;
  }
  if (/\.gif(?:[?#]|$)/i.test(url)) return false;
  return /\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(url);
}

function amazonImageIdentity(url: string): string {
  const path = url.split('?')[0];
  const match = path.match(/\/images\/(.+?)(?:\._[^/]+_)?\.(jpe?g|png|webp)$/i);
  return match ? `${match[1]}.${match[2]}`.toLowerCase() : url.toLowerCase();
}

function largestMainImage(main: unknown): string | null {
  if (!isRecord(main)) return null;
  let bestUrl: string | null = null;
  let bestArea = 0;

  for (const [url, dimensions] of Object.entries(main)) {
    const width = Array.isArray(dimensions) ? Number(dimensions[0]) : 0;
    const height = Array.isArray(dimensions) ? Number(dimensions[1]) : 0;
    const area = Number.isFinite(width) && Number.isFinite(height) ? width * height : 0;
    if (isRealImageUrl(url) && area >= bestArea) {
      bestUrl = url;
      bestArea = area;
    }
  }

  return bestUrl;
}

function addGalleryItem(
  items: Map<string, AmazonImageGalleryItem & { score: number }>,
  item: AmazonImageGalleryItem,
  score: number,
): void {
  if (!isRealImageUrl(item.url)) return;
  const key = amazonImageIdentity(item.url);
  const current = items.get(key);
  if (!current || score > current.score) {
    items.set(key, { ...item, score });
  }
}

function parseImageBlockGallery($: cheerio.CheerioAPI): AmazonImageGalleryItem[] {
  const items = new Map<string, AmazonImageGalleryItem & { score: number }>();
  const scripts = $('script')
    .map((_, script) => $(script).html() ?? '')
    .get()
    .filter((script) => script.includes('colorImages') || script.includes('ImageBlockATF'));

  for (const script of scripts) {
    const arrays = [
      ...parseJsonArrayAfter(script, "'initial'"),
      ...parseJsonArrayAfter(script, '"initial"'),
    ];
    for (const image of arrays) {
      if (!isRecord(image)) continue;
      const hiRes = getString(image['hiRes']);
      const large = getString(image['large']);
      const main = largestMainImage(image['main']);
      const url = hiRes ?? large ?? main;
      if (!url) continue;

      addGalleryItem(
        items,
        {
          url,
          thumbUrl: getString(image['thumb']),
          variant: getString(image['variant']),
          altText: getString(image['altText']),
        },
        hiRes ? 4 : large ? 3 : 2,
      );
    }
  }

  return [...items.values()].map(({ score: _score, ...item }) => item).slice(0, 18);
}

function parseFallbackGallery($: cheerio.CheerioAPI): AmazonImageGalleryItem[] {
  const items = new Map<string, AmazonImageGalleryItem & { score: number }>();
  const dynamicImage = $('#landingImage').attr('data-a-dynamic-image');
  if (dynamicImage) {
    try {
      const dynamicUrls = Object.keys(JSON.parse(dynamicImage) as Record<string, unknown>);
      const best = dynamicUrls
        .filter(isRealImageUrl)
        .sort((a, b) => a.length - b.length)
        .at(-1);
      if (best) {
        addGalleryItem(
          items,
          {
            url: best,
            thumbUrl: $('#landingImage').attr('src') ?? null,
            variant: 'MAIN',
            altText: $('#landingImage').attr('alt') ?? null,
          },
          2,
        );
      }
    } catch {
      // Ignore malformed embedded image JSON.
    }
  }

  const imageSelectors = '#landingImage, #altImages img, #imageBlock img, #imgTagWrapperId img';
  $(imageSelectors).each((_, image) => {
    const root = $(image);
    const url =
      root.attr('data-old-hires') ??
      root.attr('data-a-hires') ??
      root.attr('data-src') ??
      root.attr('src') ??
      '';
    addGalleryItem(
      items,
      {
        url,
        thumbUrl: root.attr('src') ?? null,
        variant: null,
        altText: root.attr('alt') ?? null,
      },
      url.includes('_SL') ? 2 : 1,
    );
  });

  return [...items.values()].map(({ score: _score, ...item }) => item).slice(0, 12);
}

function parseImageGallery($: cheerio.CheerioAPI): AmazonImageGalleryItem[] {
  const items = new Map<string, AmazonImageGalleryItem & { score: number }>();
  for (const item of [...parseImageBlockGallery($), ...parseFallbackGallery($)]) {
    addGalleryItem(items, item, item.url.includes('_SL') ? 4 : 2);
  }
  return [...items.values()].map(({ score: _score, ...item }) => item).slice(0, 18);
}

function parseImages($: cheerio.CheerioAPI): string[] {
  return parseImageGallery($).map((item) => item.url);
}

function appendUniquePair(
  pairs: Map<string, AmazonDetailPair>,
  label: string | null | undefined,
  value: string | null | undefined,
): void {
  const cleanLabel = stripEmbeddedScriptText(label).replace(/:$/, '');
  const cleanValue = stripEmbeddedScriptText(value);
  if (!cleanLabel || !cleanValue || cleanLabel.toLowerCase() === cleanValue.toLowerCase()) return;
  if (!pairs.has(cleanLabel.toLowerCase())) {
    pairs.set(cleanLabel.toLowerCase(), { label: cleanLabel, value: cleanValue });
  }
}

function parsePairRows($: cheerio.CheerioAPI, selector: string): AmazonDetailPair[] {
  const pairs = new Map<string, AmazonDetailPair>();

  $(selector).each((_, row) => {
    const root = $(row).clone();
    root.find('script, style, noscript').remove();
    const cells = root.find('th, td');
    const label =
      cleanText(root.find('th').first().text()) ||
      cleanText(root.find('.a-span3').first().text()) ||
      cleanText(root.find('.a-text-bold').first().text()) ||
      cleanText(cells.eq(0).text());
    let value =
      cleanText(root.find('td').not(':first-child').text()) ||
      cleanText(root.find('.a-span9').first().text()) ||
      cleanText(cells.slice(1).text());

    if (!value && cells.length === 2) {
      value = cleanText(cells.eq(1).text());
    }

    appendUniquePair(pairs, label, value);
  });

  return [...pairs.values()];
}

function parseDetailBullets($: cheerio.CheerioAPI): AmazonDetailPair[] {
  const pairs = new Map<string, AmazonDetailPair>();

  $('#detailBullets_feature_div li, #detailBulletsWrapper_feature_div li').each((_, item) => {
    const root = $(item).clone();
    root.find('script, style, noscript').remove();
    const label = cleanText(root.find('.a-text-bold').first().text()).replace(/:$/, '');
    root.find('.a-text-bold').first().remove();
    let value = cleanText(root.text()).replace(/^:\s*/, '');
    if (!label) {
      const [rawLabel, ...rawValue] = cleanText($(item).text()).split(/\s*:\s*/);
      appendUniquePair(pairs, rawLabel, rawValue.join(':'));
      return;
    }

    value = value.replace(/^[‏‎\s:]+/, '');
    appendUniquePair(pairs, label, value);
  });

  return [...pairs.values()];
}

function parseOverview($: cheerio.CheerioAPI): AmazonDetailPair[] {
  return parsePairRows(
    $,
    [
      '#productOverview_feature_div tr',
      '#productFactsDesktopExpander tr',
      '#poExpander tr',
      '#productFactsDesktopExpander .a-fixed-left-grid',
    ].join(', '),
  ).slice(0, 16);
}

function parseSpecificationGroups($: cheerio.CheerioAPI): AmazonSpecificationGroup[] {
  const groups: AmazonSpecificationGroup[] = [];
  const overview = parseOverview($);
  if (overview.length) groups.push({ title: 'Product overview', items: overview });

  const productDetails = parsePairRows(
    $,
    [
      '#prodDetails tr',
      '#productDetails_techSpec_section_1 tr',
      '#productDetails_techSpec_section_2 tr',
      '#productDetails_detailBullets_sections1 tr',
      '#productDetails_db_sections tr',
      '#productDetails_feature_div tr',
    ].join(', '),
  );
  if (productDetails.length) groups.push({ title: 'Product information', items: productDetails.slice(0, 48) });

  const bulletDetails = parseDetailBullets($);
  if (bulletDetails.length) groups.push({ title: 'Additional details', items: bulletDetails.slice(0, 24) });

  return groups;
}

function parseDetails($: cheerio.CheerioAPI, asin: string): AmazonDetailPair[] {
  const details = new Map<string, AmazonDetailPair>();
  for (const group of parseSpecificationGroups($)) {
    for (const item of group.items) appendUniquePair(details, item.label, item.value);
  }
  appendUniquePair(details, 'ASIN', asin);
  return [...details.values()].slice(0, 72);
}

function parseFeatureBullets($: cheerio.CheerioAPI): string[] {
  return uniqueValues(
    $('#feature-bullets li span.a-list-item')
      .map((_, element) => stripEmbeddedScriptText($(element).text()))
      .get()
      .filter((text) => text && !/Make sure this fits/i.test(text)),
    12,
  );
}

function parseCategoryPath($: cheerio.CheerioAPI): string[] {
  return uniqueValues(
    $('#wayfinding-breadcrumbs_feature_div a, #wayfinding-breadcrumbs_container a')
      .map((_, element) => cleanText($(element).text()).replace(/[›>]/g, ''))
      .get()
      .filter(Boolean),
    8,
  );
}

function parseBrand($: cheerio.CheerioAPI, overview: AmazonDetailPair[]): string | null {
  const overviewBrand = overview.find((item) => /^brand$/i.test(item.label))?.value;
  if (overviewBrand) return overviewBrand;

  const byline = cleanText($('#bylineInfo').text())
    .replace(/^Visit the\s+/i, '')
    .replace(/\s+Store$/i, '')
    .replace(/^Brand:\s*/i, '');
  return byline || null;
}

function parseDescription($: cheerio.CheerioAPI): string | null {
  const selectors = [
    '#productDescription',
    '#productDescription_feature_div',
    '#bookDescription_feature_div',
    '#productDescription_fullView',
  ];
  const values = selectors
    .map((selector) => {
      const root = $(selector).clone();
      root.find('script, style, noscript').remove();
      return stripEmbeddedScriptText(root.text()).replace(/^Product Description\s*/i, '');
    })
    .filter(Boolean);
  return uniqueValues(values, 1)[0] ?? null;
}

function parseImportantInformation($: cheerio.CheerioAPI): string[] {
  const root = $('#importantInformation').clone();
  root.find('script, style, noscript').remove();
  if (!root.length) return [];

  const pieces = root
    .find('h4, h5, p, li, .content')
    .map((_, element) => stripEmbeddedScriptText($(element).text()))
    .get()
    .filter((text) => text && !/^Important information$/i.test(text));

  return uniqueValues(pieces, 8);
}

function isUsefulRichText(text: string): boolean {
  if (text.length < 3) return false;
  if (/^(function|var|window\.|P\.when|ue\.|if\s*\()/i.test(text)) return false;
  if (/\.aplus-|aplus-v2|background-repeat|font-size|shoppable/i.test(text)) return false;
  if (/[{};]/.test(text) && text.length > 80) return false;
  return true;
}

function collectImageUrlsFromRoot(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<AnyNode>,
): string[] {
  const urls: string[] = [];

  root.find('img').each((_, image) => {
    const node = $(image);
    urls.push(
      ...[
        node.attr('data-src'),
        node.attr('data-a-hires'),
        node.attr('data-old-hires'),
        node.attr('src'),
      ].filter((value): value is string => Boolean(value)),
    );
  });

  root.find('[style*="background"]').each((_, element) => {
    const style = $(element).attr('style') ?? '';
    for (const match of style.matchAll(/url\((['"]?)(.*?)\1\)/gi)) {
      if (match[2]) urls.push(match[2]);
    }
  });

  return uniqueValues(urls.filter(isRealImageUrl), 16);
}

function parseRichContentSections($: cheerio.CheerioAPI): AmazonRichContentSection[] {
  const container = $('#aplus, #aplus_feature_div').clone();
  container.find('script, style, noscript').remove();
  if (!container.length) return [];

  let modules = container.find('.aplus-module, .apm-spacing, .celwidget');
  if (!modules.length) modules = container.children();

  const sections: AmazonRichContentSection[] = [];
  modules.each((_, element) => {
    const root = $(element).clone();
    root.find('script, style, noscript').remove();
    const heading = cleanText(root.find('h1, h2, h3, h4').first().text()) || null;
    const textBlocks = uniqueValues(
      root
        .find('h1, h2, h3, h4, p, li, td')
        .map((__, node) => stripEmbeddedScriptText($(node).text()))
        .get()
        .filter(isUsefulRichText),
      8,
    ).filter((text) => text !== heading);
    const images = collectImageUrlsFromRoot($, root).slice(0, 6);

    if (!heading && !textBlocks.length && !images.length) return;
    sections.push({ heading, textBlocks, images });
  });

  return sections.slice(0, 14);
}

function normalizeReviewTitle(value: string): string | null {
  const title = stripEmbeddedScriptText(value).replace(/^\d(?:\.\d)? out of 5 stars\s*/i, '');
  return title || null;
}

function normalizeReviewBody(value: string): string | null {
  const body = stripEmbeddedScriptText(value)
    .replace(/Brief content visible, double tap to read full content\./gi, '')
    .replace(/Full content visible, double tap to read brief content\./gi, '')
    .replace(/Read more\s*Read less/gi, '')
    .replace(/Read more|Read less/gi, '')
    .trim();
  return body || null;
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
        title: normalizeReviewTitle(
          root.find('[data-hook="review-title"], [data-hook="reviewTitle"]').text(),
        ),
        body: normalizeReviewBody(
          root.find('[data-hook="review-body"], [data-hook="reviewText"]').text(),
        ),
        author: cleanText(root.find('.a-profile-name').first().text()) || null,
        date: cleanText(root.find('[data-hook="review-date"]').first().text()) || null,
        helpful: cleanText(root.find('[data-hook="helpful-vote-statement"]').first().text()) || null,
      };
    })
    .get()
    .filter((review) => review.title || review.body)
    .slice(0, 8);
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

  const imageGallery = parseImageGallery($);
  const overview = parseOverview($);
  const specificationGroups = parseSpecificationGroups($);

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
        pickText($, '#corePrice_feature_div .a-price .a-offscreen') ??
        pickText($, '.a-price .a-offscreen'),
      rating:
        pickText($, '#acrPopover .a-icon-alt') ??
        pickText($, '.reviewCountTextLinkedHistogram .a-icon-alt'),
      reviewCount: pickText($, '#acrCustomerReviewText'),
      availability: stripEmbeddedScriptText($('#availability').first().text()) || null,
      images: imageGallery.map((item) => item.url),
      imageGallery,
      categoryPath: parseCategoryPath($),
      brand: parseBrand($, overview),
      overview,
      description: parseDescription($),
      importantInformation: parseImportantInformation($),
      featureBullets: parseFeatureBullets($),
      details: parseDetails($, asin),
      specificationGroups,
      richContentSections: parseRichContentSections($),
      reviewSignals: parseReviewSignals($),
    },
  };
}
