import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { fetchText } from '../core/fetch-page.js';
import { ExtractError, type ExtractSuccess, unsupported } from '../core/types.js';

export interface GoogleFlightsAirport {
  code: string | null;
  name: string | null;
  display: string;
}

export interface GoogleFlightsSchedulePoint extends GoogleFlightsAirport {
  dateText: string;
  timeText: string;
  localDate: string | null;
  localDateTime: string | null;
}

export interface GoogleFlightsLayover {
  airportCode: string | null;
  airportName: string | null;
  durationText: string;
  durationMinutes: number | null;
}

export interface GoogleFlightsPrice {
  status: 'available' | 'unavailable';
  display: string;
  amount: number | null;
  currency: 'USD' | null;
}

export interface GoogleFlightsBaggage {
  carryOnIncluded: number | null;
  checkedIncluded: number | null;
}

export interface GoogleFlightsEmissions {
  display: string | null;
  kilogramsCo2e: number | null;
  comparisonText: string | null;
  differencePercent: number | null;
}

export interface GoogleFlightEntry {
  id: string;
  group: 'top' | 'other';
  rawLabel: string;
  airlines: string[];
  departure: GoogleFlightsSchedulePoint;
  arrival: GoogleFlightsSchedulePoint;
  durationText: string;
  durationMinutes: number | null;
  stops: number | null;
  stopsText: string;
  layovers: GoogleFlightsLayover[];
  price: GoogleFlightsPrice;
  baggage: GoogleFlightsBaggage;
  emissions: GoogleFlightsEmissions;
  sourceEntryId: string | null;
  travelImpactModelUrl: string | null;
  detailsUrl: string | null;
}

export interface GoogleFlightsSearchData {
  pageTitle: string;
  tripType: string | null;
  cabinClass: string | null;
  passengerCount: number | null;
  departureDate: string | null;
  currency: 'USD';
  origin: GoogleFlightsAirport | null;
  destination: GoogleFlightsAirport | null;
  summary: {
    total: number;
    topCount: number;
    otherCount: number;
    lowestPrice: number | null;
    lowestPriceDisplay: string | null;
    priceInsight: string | null;
  };
  flights: GoogleFlightEntry[];
  searchCriteria?: GoogleFlightsSearchCriteria;
}

export type GoogleFlightsTripType = 'one-way' | 'round-trip';
export type GoogleFlightsCabinClass = 'economy' | 'premium-economy' | 'business' | 'first';

export interface GoogleFlightsSearchCriteria {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  tripType: GoogleFlightsTripType;
  adults: number;
  cabinClass: GoogleFlightsCabinClass;
}

export interface GoogleFlightsStructuredSearchInput {
  origin?: unknown;
  destination?: unknown;
  departureDate?: unknown;
  returnDate?: unknown;
  tripType?: unknown;
  adults?: unknown;
  cabinClass?: unknown;
}

const GOOGLE_HOSTS = new Set(['google.com', 'www.google.com']);

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/[\s\u202f\u00a0]+/g, ' ').trim();
}

function extractBalancedArray(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function extractFlightPriceTokens($: cheerio.CheerioAPI): Map<string, string> {
  const tokens = new Map<string, string>();
  const script = $('script')
    .map((_, element) => $(element).html() ?? '')
    .get()
    .find((content) => /key:\s*['"]ds:1['"]/.test(content));
  if (!script) return tokens;
  const dataMarker = script.indexOf('data:');
  const arrayStart = script.indexOf('[', dataMarker);
  if (dataMarker < 0 || arrayStart < 0) return tokens;
  const rawData = extractBalancedArray(script, arrayStart);
  if (!rawData) return tokens;

  let data: unknown;
  try {
    data = JSON.parse(rawData) as unknown;
  } catch {
    return tokens;
  }

  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    const pricePair = value.find(
      (item): item is [unknown[], string] =>
        Array.isArray(item) &&
        item.length === 2 &&
        Array.isArray(item[0]) &&
        typeof item[1] === 'string' &&
        item[1].length > 40 &&
        /^[A-Za-z0-9_+/=-]+$/.test(item[1]),
    );
    const flightRecord = value.find(
      (item): item is unknown[] =>
        Array.isArray(item) &&
        item.length > 18 &&
        typeof item[0] === 'string' &&
        typeof item[3] === 'string' &&
        /^[A-Z]{3}$/.test(item[3]) &&
        Array.isArray(item[4]) &&
        typeof item[6] === 'string' &&
        /^[A-Z]{3}$/.test(item[6]) &&
        typeof item[17] === 'string',
    );
    const entryId = flightRecord?.[17] ?? value.find(
      (item): item is string => typeof item === 'string' && /^[A-Za-z0-9_-]{4,12}$/.test(item),
    );
    if (typeof entryId === 'string' && pricePair) tokens.set(entryId, pricePair[1]);
    for (const child of value) visit(child);
  };
  visit(data);
  return tokens;
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function decodeVarint(buffer: Buffer, offset: number): { value: number; end: number } | null {
  let value = 0;
  let multiplier = 1;
  for (let index = offset; index < buffer.length && index < offset + 10; index += 1) {
    const byte = buffer[index];
    if (byte === undefined) return null;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, end: index + 1 };
    multiplier *= 128;
  }
  return null;
}

function encodeBytes(field: number, value: Buffer): Buffer {
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(value.length), value]);
}

function encodeString(field: number, value: string): Buffer {
  return encodeBytes(field, Buffer.from(value, 'utf8'));
}

function encodeInteger(field: number, value: number): Buffer {
  return Buffer.concat([encodeVarint(field << 3), encodeVarint(value)]);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 0));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() + 1 === month &&
    parsed.getUTCDate() === day;
}

function currentIsoDate(now: Date): string {
  return [
    now.getUTCFullYear().toString().padStart(4, '0'),
    (now.getUTCMonth() + 1).toString().padStart(2, '0'),
    now.getUTCDate().toString().padStart(2, '0'),
  ].join('-');
}

function normalizeAirportCode(value: unknown, label: string): string {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(code)) {
    unsupported(`${label} must be a three-letter IATA airport code`);
  }
  return code;
}

export function normalizeGoogleFlightsSearchCriteria(
  input: GoogleFlightsStructuredSearchInput,
  now = new Date(),
): GoogleFlightsSearchCriteria {
  const origin = normalizeAirportCode(input.origin, 'Origin');
  const destination = normalizeAirportCode(input.destination, 'Destination');
  if (origin === destination) unsupported('Origin and destination must be different airports');

  const tripType = input.tripType;
  if (tripType !== 'one-way' && tripType !== 'round-trip') {
    unsupported('Google Flights tripType must be "one-way" or "round-trip"');
  }

  const cabinClass = input.cabinClass;
  if (!['economy', 'premium-economy', 'business', 'first'].includes(String(cabinClass))) {
    unsupported('Google Flights cabinClass must be economy, premium-economy, business, or first');
  }

  const adults = input.adults;
  if (!Number.isInteger(adults) || Number(adults) < 1 || Number(adults) > 9) {
    unsupported('Google Flights adults must be an integer from 1 to 9');
  }

  const departureDate = typeof input.departureDate === 'string' ? input.departureDate.trim() : '';
  if (!isIsoDate(departureDate)) unsupported('Google Flights departureDate must be a valid YYYY-MM-DD date');
  if (departureDate < currentIsoDate(now)) unsupported('Google Flights departureDate cannot be in the past');

  const returnDate = typeof input.returnDate === 'string' ? input.returnDate.trim() : '';
  if (tripType === 'round-trip') {
    if (!isIsoDate(returnDate)) unsupported('Round-trip searches require a valid returnDate');
    if (returnDate < departureDate) unsupported('Google Flights returnDate cannot be before departureDate');
  }

  return {
    origin,
    destination,
    departureDate,
    ...(tripType === 'round-trip' ? { returnDate } : {}),
    tripType,
    adults: Number(adults),
    cabinClass: cabinClass as GoogleFlightsCabinClass,
  };
}

function encodeAirport(code: string): Buffer {
  return Buffer.concat([encodeInteger(1, 1), encodeString(2, code)]);
}

function encodeFlightLeg(origin: string, destination: string, date: string): Buffer {
  return Buffer.concat([
    encodeString(2, date),
    encodeBytes(13, encodeAirport(origin)),
    encodeBytes(14, encodeAirport(destination)),
  ]);
}

const CABIN_CLASS_CODES: Record<GoogleFlightsCabinClass, number> = {
  economy: 1,
  'premium-economy': 2,
  business: 3,
  first: 4,
};

export function buildGoogleFlightsSearchUrl(criteria: GoogleFlightsSearchCriteria): URL {
  const legs = [encodeFlightLeg(criteria.origin, criteria.destination, criteria.departureDate)];
  if (criteria.tripType === 'round-trip' && criteria.returnDate) {
    legs.push(encodeFlightLeg(criteria.destination, criteria.origin, criteria.returnDate));
  }

  const filterDefaults = Buffer.from('08ffffffffffffffffff01', 'hex');
  const payload = Buffer.concat([
    encodeInteger(1, 28),
    encodeInteger(2, criteria.tripType === 'one-way' ? 2 : 0),
    ...legs.map((leg) => encodeBytes(3, leg)),
    ...Array.from({ length: criteria.adults }, () => encodeInteger(8, 1)),
    encodeInteger(9, CABIN_CLASS_CODES[criteria.cabinClass]),
    encodeInteger(14, 1),
    encodeBytes(16, filterDefaults),
    encodeInteger(19, criteria.tripType === 'one-way' ? 2 : 1),
  ]);

  const url = new URL('https://www.google.com/travel/flights/search');
  url.searchParams.set('tfs', payload.toString('base64url'));
  url.searchParams.set('hl', 'en-US');
  url.searchParams.set('gl', 'US');
  url.searchParams.set('curr', 'USD');
  return url;
}

export function buildGoogleFlightsResultsFetchUrl(criteria: GoogleFlightsSearchCriteria): URL {
  if (criteria.tripType === 'one-way') return buildGoogleFlightsSearchUrl(criteria);
  // Google currently returns only a client-side loading shell for round-trip
  // deep links in the initial HTML response. Fetch the equivalent outbound
  // one-way page for its server-rendered list, while the caller retains the
  // round-trip source URL for detail-link selection context.
  return buildGoogleFlightsSearchUrl({
    ...criteria,
    tripType: 'one-way',
    returnDate: undefined,
  });
}

function replaceSearchSelection(searchTfs: string, selections: Buffer[]): string | null {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(searchTfs.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  } catch {
    return null;
  }

  let offset = 0;
  while (offset < decoded.length) {
    const tag = decodeVarint(decoded, offset);
    if (!tag) return null;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (wire === 2) {
      const length = decodeVarint(decoded, tag.end);
      if (!length) return null;
      const valueStart = length.end;
      const valueEnd = valueStart + length.value;
      if (valueEnd > decoded.length) return null;
      if (field === 3) {
        const existing = decoded.subarray(valueStart, valueEnd);
        const selected = Buffer.concat(selections.map((selection) => encodeBytes(4, selection)));
        const replacement = encodeBytes(3, Buffer.concat([existing, selected]));
        return Buffer.concat([decoded.subarray(0, offset), replacement, decoded.subarray(valueEnd)])
          .toString('base64url');
      }
      offset = valueEnd;
      continue;
    }
    if (wire === 0) {
      const value = decodeVarint(decoded, tag.end);
      if (!value) return null;
      offset = value.end;
      continue;
    }
    if (wire === 1) offset = tag.end + 8;
    else if (wire === 5) offset = tag.end + 4;
    else return null;
  }
  return null;
}

function itinerarySelections(impactUrl: string | null): Buffer[] {
  if (!impactUrl) return [];
  let itinerary: string | null;
  try {
    itinerary = new URL(impactUrl).searchParams.get('itinerary');
  } catch {
    return [];
  }
  if (!itinerary) return [];

  return itinerary.split(',').flatMap((segment) => {
    const match = segment.match(/^([A-Z]{3})-([A-Z]{3})-([A-Z0-9]{2})-(\d+)-(\d{4})(\d{2})(\d{2})$/);
    if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5] || !match[6] || !match[7]) return [];
    const date = `${match[5]}-${match[6]}-${match[7]}`;
    return [Buffer.concat([
      encodeString(1, match[1]),
      encodeString(2, date),
      encodeString(3, match[2]),
      encodeString(5, match[3]),
      encodeString(6, match[4]),
    ])];
  });
}

function buildDetailsUrl(
  searchUrl: URL | null,
  impactUrl: string | null,
  priceToken: string | null,
): string | null {
  const searchTfs = searchUrl?.searchParams.get('tfs');
  const selections = itinerarySelections(impactUrl);
  if (!searchTfs || !priceToken || selections.length === 0) return null;
  const bookingTfs = replaceSearchSelection(searchTfs, selections);
  if (!bookingTfs) return null;
  const bookingTfu = Buffer.concat([
    encodeString(1, priceToken),
    encodeBytes(2, Buffer.from([0x08, 0x00])),
    encodeBytes(4, encodeString(1, '0')),
  ]).toString('base64url');
  const url = new URL('https://www.google.com/travel/flights/booking');
  url.searchParams.set('tfs', bookingTfs);
  url.searchParams.set('tfu', bookingTfu);
  url.searchParams.set('hl', 'en-US');
  url.searchParams.set('gl', 'US');
  url.searchParams.set('curr', 'USD');
  return url.href;
}

function validateGoogleFlightsUrl(input: unknown): URL {
  if (typeof input !== 'string' || !input.trim()) {
    unsupported('Google Flights search requires a search URL');
  }

  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    unsupported('Invalid Google Flights URL');
  }

  if (!GOOGLE_HOSTS.has(url.hostname)) {
    unsupported('Only google.com Google Flights URLs are supported');
  }
  if (url.pathname === '/travel/flights/booking') {
    unsupported('Google Flights booking detail pages are not supported yet');
  }
  if (url.pathname !== '/travel/flights/search' || !url.searchParams.get('tfs')) {
    unsupported('Google Flights URL must be a /travel/flights/search URL with a tfs parameter');
  }

  url.protocol = 'https:';
  url.hostname = 'www.google.com';
  url.searchParams.set('hl', 'en-US');
  url.searchParams.set('gl', 'US');
  url.searchParams.set('curr', 'USD');
  return url;
}

export function canHandleGoogleFlightsUrl(url: URL): 'search' | 'booking' | null {
  if (!GOOGLE_HOSTS.has(url.hostname)) return null;
  if (url.pathname === '/travel/flights/booking') return 'booking';
  if (url.pathname === '/travel/flights/search' && url.searchParams.get('tfs')) return 'search';
  return null;
}

function parseDurationMinutes(value: string): number | null {
  const hours = Number.parseInt(value.match(/(\d+)\s*hr/)?.[1] ?? '0', 10);
  const minutes = Number.parseInt(value.match(/(\d+)\s*min/)?.[1] ?? '0', 10);
  const total = hours * 60 + minutes;
  return total > 0 ? total : null;
}

const MONTHS: Record<string, number> = {
  January: 0,
  February: 1,
  March: 2,
  April: 3,
  May: 4,
  June: 5,
  July: 6,
  August: 7,
  September: 8,
  October: 9,
  November: 10,
  December: 11,
};

function localDateFromText(value: string, anchorDate: string | null): string | null {
  const match = value.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+(\w+)\s+(\d{1,2})/);
  if (!match?.[1] || !match[2] || MONTHS[match[1]] === undefined) return null;

  const anchor = anchorDate ? new Date(`${anchorDate}T00:00:00Z`) : null;
  const baseYear = anchor && !Number.isNaN(anchor.valueOf()) ? anchor.getUTCFullYear() : null;
  if (baseYear === null) return null;
  const anchorValue = anchor?.valueOf();
  if (anchorValue === undefined) return null;

  const month = MONTHS[match[1]];
  const day = Number.parseInt(match[2], 10);
  const candidates = [baseYear - 1, baseYear, baseYear + 1].map(
    (year) => new Date(Date.UTC(year, month, day)),
  );
  const closest = candidates.reduce((best, candidate) =>
    Math.abs(candidate.valueOf() - anchorValue) < Math.abs(best.valueOf() - anchorValue)
      ? candidate
      : best,
  );
  return closest.toISOString().slice(0, 10);
}

function time24(value: string): string | null {
  const match = value.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  let hours = Number.parseInt(match[1], 10) % 12;
  if (match[3].toUpperCase() === 'PM') hours += 12;
  return `${String(hours).padStart(2, '0')}:${match[2]}:00`;
}

function parseAirport(displayName: string, code: string | null): GoogleFlightsAirport {
  return { code, name: cleanText(displayName) || null, display: code ? `${cleanText(displayName)} (${code})` : cleanText(displayName) };
}

function parseAirlines(value: string): string[] {
  return value
    .split(/,\s+|\s+and\s+/)
    .map(cleanText)
    .filter(Boolean);
}

function parseLayovers(rawLabel: string, airportCodes: string[]): GoogleFlightsLayover[] {
  const layovers: GoogleFlightsLayover[] = [];
  const pattern = /Layover \(\d+ of \d+\) is a ([^.]+?) layover at ([^.]+?)(?: in [^.]+)?\./g;
  for (const match of rawLabel.matchAll(pattern)) {
    const durationText = cleanText(match[1]);
    const airportName = cleanText(match[2]);
    layovers.push({
      airportCode: airportCodes[layovers.length] ?? null,
      airportName: airportName || null,
      durationText,
      durationMinutes: parseDurationMinutes(durationText),
    });
  }
  return layovers;
}

function parseEntry(
  $: cheerio.CheerioAPI,
  entry: AnyNode,
  group: 'top' | 'other',
  departureDate: string | null,
  searchUrl: URL | null,
  priceTokens: Map<string, string>,
): GoogleFlightEntry | null {
  const link = $(entry);
  const rawLabel = cleanText(link.attr('aria-label'));
  const core = rawLabel.match(
    /^(From ([\d,]+) US dollars|Total price is unavailable)\.\s*(Nonstop|\d+ stops?) flight with (.+?)\.\s*Leaves (.+?) at (\d{1,2}:\d{2}\s*[AP]M) on (.+?) and arrives at (.+?) at (\d{1,2}:\d{2}\s*[AP]M) on (.+?)\.\s*Total duration ([^.]+)\./i,
  );
  if (!core) return null;

  const container = link.closest('li');
  const root = container.length ? container : link.parent().parent();
  const sourceEntryId = link.closest('[data-id]').attr('data-id') ?? null;
  const impactUrl = root.find('[data-travelimpactmodelwebsiteurl]').first().attr('data-travelimpactmodelwebsiteurl') ?? null;
  const codes = root
    .find('*')
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter((text) => /^[A-Z]{3}$/.test(text))
    .filter((code, index, values) => values.indexOf(code) === index);
  const departureCode = codes[0] ?? null;
  const arrivalCode = codes.find((code) => code !== departureCode) ?? codes[1] ?? null;
  const departureDateText = cleanText(core[7]);
  const arrivalDateText = cleanText(core[10]);
  const departureLocalDate = localDateFromText(departureDateText, departureDate);
  const arrivalLocalDate = localDateFromText(arrivalDateText, departureDate);
  const departureTime = cleanText(core[6]);
  const arrivalTime = cleanText(core[9]);
  const departureTime24 = time24(departureTime);
  const arrivalTime24 = time24(arrivalTime);
  const stopsText = cleanText(core[3]);
  const stops = /^nonstop$/i.test(stopsText)
    ? 0
    : Number.parseInt(stopsText.match(/\d+/)?.[0] ?? '', 10);
  const priceAmount = core[2] ? Number.parseInt(core[2].replaceAll(',', ''), 10) : null;
  const carryOn = rawLabel.match(/(\d+) carry-on bags? included/i)?.[1];
  const checked = rawLabel.match(/(\d+) checked bags? included/i)?.[1];
  const emissionsLabel = root
    .find('[aria-label^="Carbon emissions estimate:"]')
    .first()
    .attr('aria-label');
  const emissionsKg = emissionsLabel?.match(/estimate:\s*([\d,]+) kilograms/i)?.[1];
  const percent = emissionsLabel?.match(/([+-]\d+)% emissions/i)?.[1];
  const comparison = emissionsLabel?.match(/kilograms\.\s*(.+? emissions)\./i)?.[1] ?? null;
  const airlines = parseAirlines(cleanText(core[4]));
  const durationText = cleanText(core[11]);

  return {
    id: sourceEntryId ?? [airlines.join(','), departureTime, arrivalTime, priceAmount ?? 'unavailable'].join('|'),
    group,
    rawLabel,
    airlines,
    departure: {
      ...parseAirport(cleanText(core[5]), departureCode),
      dateText: departureDateText,
      timeText: departureTime,
      localDate: departureLocalDate,
      localDateTime: departureLocalDate && departureTime24 ? `${departureLocalDate}T${departureTime24}` : null,
    },
    arrival: {
      ...parseAirport(cleanText(core[8]), arrivalCode),
      dateText: arrivalDateText,
      timeText: arrivalTime,
      localDate: arrivalLocalDate,
      localDateTime: arrivalLocalDate && arrivalTime24 ? `${arrivalLocalDate}T${arrivalTime24}` : null,
    },
    durationText,
    durationMinutes: parseDurationMinutes(durationText),
    stops: Number.isFinite(stops) ? stops : null,
    stopsText,
    layovers: parseLayovers(rawLabel, codes.slice(2)),
    price: priceAmount === null
      ? { status: 'unavailable', display: 'Price unavailable', amount: null, currency: null }
      : { status: 'available', display: `$${priceAmount.toLocaleString('en-US')}`, amount: priceAmount, currency: 'USD' },
    baggage: {
      carryOnIncluded: carryOn ? Number.parseInt(carryOn, 10) : null,
      checkedIncluded: checked ? Number.parseInt(checked, 10) : null,
    },
    emissions: {
      display: emissionsKg ? `${emissionsKg} kg CO2e` : null,
      kilogramsCo2e: emissionsKg ? Number.parseInt(emissionsKg.replaceAll(',', ''), 10) : null,
      comparisonText: comparison ? cleanText(comparison) : null,
      differencePercent: percent ? Number.parseInt(percent, 10) : null,
    },
    sourceEntryId,
    travelImpactModelUrl: impactUrl,
    detailsUrl: buildDetailsUrl(
      searchUrl,
      impactUrl,
      sourceEntryId ? priceTokens.get(sourceEntryId) ?? null : null,
    ),
  };
}

function controlValue($: cheerio.CheerioAPI, prefix: string): string | null {
  const control = $(`[aria-label^="${prefix}"]`).first();
  const ariaValue = $(`[aria-label^="${prefix}"]`)
    .map((_, element) => cleanText(($(element).attr('aria-label') ?? '').slice(prefix.length)))
    .get()
    .find(Boolean);
  if (ariaValue) return ariaValue;
  return cleanText(control.parent().find('[jsname="Fb0Bif"]').first().text()) || null;
}

export function parseGoogleFlightsSearchHtml(
  html: string,
  sourceUrl?: URL | string,
): GoogleFlightsSearchData {
  const $ = cheerio.load(html);
  let parsedSourceUrl: URL | null = null;
  try {
    parsedSourceUrl = sourceUrl ? new URL(sourceUrl.toString()) : null;
  } catch {
    parsedSourceUrl = null;
  }
  const priceTokens = extractFlightPriceTokens($);
  const bodyText = cleanText($('body').text());
  if (/unusual traffic|verify you are human|Our systems have detected/i.test(bodyText)) {
    throw new ExtractError('REMOTE_BLOCKED', 'Google Flights returned a verification page', 502);
  }

  const departureDate =
    $('[aria-label*="departing "]')
      .map((_, element) => $(element).attr('aria-label')?.match(/departing (\d{4}-\d{2}-\d{2})/)?.[1])
      .get()
      .find(Boolean) ?? null;
  const headingPositions: Array<{ position: number; group: 'top' | 'other' }> = [];
  const positions = new Map<AnyNode, number>();
  $('*').each((position, element) => {
    positions.set(element, position);
  });
  $('h1, h2, h3, h4, [role="heading"]').each((_, element) => {
    const text = cleanText($(element).text());
    if (text === 'Top flights') headingPositions.push({ position: positions.get(element) ?? 0, group: 'top' });
    if (text === 'Other flights') headingPositions.push({ position: positions.get(element) ?? 0, group: 'other' });
  });
  headingPositions.sort((a, b) => a.position - b.position);

  const seen = new Set<string>();
  const flights: GoogleFlightEntry[] = [];
  $('[role="link"][aria-label*="Select flight"]').each((_, element) => {
    const position = positions.get(element) ?? 0;
    const group = [...headingPositions].reverse().find((heading) => heading.position < position)?.group ?? 'other';
    const flight = parseEntry($, element, group, departureDate, parsedSourceUrl, priceTokens);
    if (!flight || seen.has(flight.id)) return;
    seen.add(flight.id);
    flights.push(flight);
  });

  if (flights.length === 0) {
    if (/Loading results|Fetching results/i.test(bodyText)) {
      throw new ExtractError('REMOTE_BLOCKED', 'Google Flights results were not present in the initial HTML response', 502);
    }
    throw new ExtractError('PARSE_FAILED', 'No Google Flights search results were found', 502);
  }

  const availablePrices = flights.filter((flight) => flight.price.amount !== null);
  const lowest = availablePrices.reduce<GoogleFlightEntry | null>(
    (best, flight) => !best || (flight.price.amount ?? Infinity) < (best.price.amount ?? Infinity) ? flight : best,
    null,
  );
  const first = flights[0] ?? null;
  const priceInsight = $('h3, h4, [role="heading"]')
    .map((_, element) => cleanText($(element).text()))
    .get()
    .find((text) => /^Prices are currently | is (?:low|typical|high)/i.test(text)) ?? null;
  const passengerLabel = $('[aria-label*="passenger, change number of passengers"], [aria-label*="passengers, change number of passengers"]')
    .first()
    .attr('aria-label');

  return {
    pageTitle: cleanText($('title').text()),
    tripType: controlValue($, 'Change ticket type.'),
    cabinClass: controlValue($, 'Change seating class.'),
    passengerCount: passengerLabel ? Number.parseInt(passengerLabel, 10) || null : null,
    departureDate,
    currency: 'USD',
    origin: first ? { code: first.departure.code, name: first.departure.name, display: first.departure.display } : null,
    destination: first ? { code: first.arrival.code, name: first.arrival.name, display: first.arrival.display } : null,
    summary: {
      total: flights.length,
      topCount: flights.filter((flight) => flight.group === 'top').length,
      otherCount: flights.filter((flight) => flight.group === 'other').length,
      lowestPrice: lowest?.price.amount ?? null,
      lowestPriceDisplay: lowest?.price.display ?? null,
      priceInsight,
    },
    flights,
  };
}

export async function extractGoogleFlightsSearch(input: {
  url?: unknown;
}): Promise<ExtractSuccess<GoogleFlightsSearchData>> {
  const url = validateGoogleFlightsUrl(input.url);
  const html = await fetchText(url, { timeoutMs: 20000 });
  return {
    ok: true,
    provider: 'google-flights',
    type: 'search',
    sourceUrl: url.href,
    data: parseGoogleFlightsSearchHtml(html, url),
  };
}

export async function extractGoogleFlightsStructuredSearch(
  input: GoogleFlightsStructuredSearchInput,
): Promise<ExtractSuccess<GoogleFlightsSearchData>> {
  const searchCriteria = normalizeGoogleFlightsSearchCriteria(input);
  const sourceUrl = buildGoogleFlightsSearchUrl(searchCriteria);
  const fetchUrl = buildGoogleFlightsResultsFetchUrl(searchCriteria);
  const html = await fetchText(fetchUrl, { timeoutMs: 20000 });
  const parsed = parseGoogleFlightsSearchHtml(html, sourceUrl);
  return {
    ok: true,
    provider: 'google-flights',
    type: 'search',
    sourceUrl: sourceUrl.href,
    data: {
      ...parsed,
      tripType: searchCriteria.tripType === 'round-trip' ? 'Round trip' : 'One way',
      searchCriteria,
    },
  };
}
