import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGoogleFlightsSearchUrl,
  canHandleGoogleFlightsUrl,
  extractGoogleFlightsSearch,
  normalizeGoogleFlightsSearchCriteria,
  parseGoogleFlightsSearchHtml,
} from './google-flights.js';

const topLabel =
  'From 149 US dollars. Nonstop flight with Frontier. Leaves Hartsfield-Jackson Atlanta International Airport at 1:36 PM on Monday, October 19 and arrives at Minneapolis-Saint Paul International Airport at 3:18 PM on Monday, October 19. Total duration 2 hr 42 min. 0 carry-on bags included. 0 checked bags included. Select flight';
const otherLabel =
  'Total price is unavailable. 1 stop flight with Delta and United. Leaves Hartsfield-Jackson Atlanta International Airport at 8:45 PM on Monday, October 19 and arrives at Minneapolis-Saint Paul International Airport at 12:15 AM on Tuesday, October 20. Total duration 4 hr 30 min. Layover (1 of 1) is a 55 min layover at Chicago O’Hare International Airport in Chicago. 1 carry-on bag included. 1 checked bag included. Select flight';

function flightItem(
  id: string,
  label: string,
  itinerary: string,
  emissionsLabel?: string,
): string {
  return `
    <li>
      <div data-id="${id}">
        <div role="link" aria-label="${label}"></div>
        <span>ATL</span><span>MSP</span>
        ${
          emissionsLabel
            ? `<button aria-label="${emissionsLabel}"></button>`
            : ''
        }
        <div data-travelimpactmodelwebsiteurl="https://www.travelimpactmodel.org/lookup/flight?itinerary=${itinerary}"></div>
      </div>
    </li>`;
}

const fixture = `<!doctype html>
  <html>
    <head><title>Atlanta to Minneapolis | Google Flights</title></head>
    <body>
      <div><span aria-label="Change ticket type."></span><span jsname="Fb0Bif">One way</span></div>
      <div><span aria-label="Change seating class."></span><span jsname="Fb0Bif">Economy (include Basic)</span></div>
      <button aria-label="1 passenger, change number of passengers."></button>
      <div aria-label="Track prices from Atlanta to Minneapolis departing 2026-10-19"></div>
      <h3>Top flights</h3>
      <ul>
        ${flightItem('Top001', topLabel, 'ATL-MSP-F9-3045-20261019', 'Carbon emissions estimate: 108 kilograms. -46% emissions. Learn more about this emissions estimate')}
        ${flightItem('Top001', topLabel, 'ATL-MSP-F9-3045-20261019')}
      </ul>
      <h3>Prices are currently high</h3>
      <h3>Other flights</h3>
      <ul>
        ${flightItem('Other1', otherLabel, 'ATL-ORD-DL-111-20261019,ORD-MSP-UA-222-20261020', 'Carbon emissions estimate: 204 kilograms. Average emissions. Learn more about this emissions estimate')}
      </ul>
      <script>
        AF_initDataCallback({key: 'ds:1', data:[
          ["Top001", [[null,149], "CjRIbmNqOVZEazRkMklBT3NlTGdCRy0tLS0tLS0tLS15aWN5OEFBQUFBR3BkcnVnSUxYLU1BEgZGOTMwNDUaCgiydBACGgNVU0Q4HXCydA=="]],
          ["Other1", [[], "CjRIbmNqOVZEazRkMklBT3NlTGdCRy0tLS0tLS0tLS15aWN5OEFBQUFBR3BkcnVnSUxYLU1BEgZERDExMRobCgiydBACGgNVU0Q4HXCydA=="]]
        ]});
      </script>
    </body>
  </html>`;

function readVarint(buffer: Buffer, start: number): { value: number; end: number } {
  let value = 0;
  let multiplier = 1;
  for (let index = start; index < buffer.length; index += 1) {
    const byte = buffer[index];
    assert.notEqual(byte, undefined);
    value += (byte! & 0x7f) * multiplier;
    if ((byte! & 0x80) === 0) return { value, end: index + 1 };
    multiplier *= 128;
  }
  throw new Error('Invalid varint');
}

function outerVarints(url: URL): Map<number, number[]> {
  const buffer = Buffer.from(url.searchParams.get('tfs') ?? '', 'base64url');
  const values = new Map<number, number[]>();
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (wire === 0) {
      const value = readVarint(buffer, tag.end);
      values.set(field, [...(values.get(field) ?? []), value.value]);
      offset = value.end;
    } else if (wire === 2) {
      const length = readVarint(buffer, tag.end);
      offset = length.end + length.value;
    } else {
      throw new Error(`Unsupported wire type ${wire}`);
    }
  }
  return values;
}

test('normalizes and encodes one-way structured searches', () => {
  const criteria = normalizeGoogleFlightsSearchCriteria({
    origin: 'jfk',
    destination: ' lax ',
    departureDate: '2099-08-10',
    tripType: 'one-way',
    adults: 2,
    cabinClass: 'business',
  }, new Date('2099-01-01T00:00:00Z'));
  assert.deepEqual(criteria, {
    origin: 'JFK',
    destination: 'LAX',
    departureDate: '2099-08-10',
    tripType: 'one-way',
    adults: 2,
    cabinClass: 'business',
  });

  const url = buildGoogleFlightsSearchUrl(criteria);
  const decoded = Buffer.from(url.searchParams.get('tfs') ?? '', 'base64url');
  const fields = outerVarints(url);
  assert.equal(url.pathname, '/travel/flights/search');
  assert.equal(decoded.includes(Buffer.from('JFK')), true);
  assert.equal(decoded.includes(Buffer.from('LAX')), true);
  assert.equal(decoded.includes(Buffer.from('2099-08-10')), true);
  assert.deepEqual(fields.get(2), [2]);
  assert.deepEqual(fields.get(9), [2]);
  assert.deepEqual(fields.get(19), [3]);
});

test('encodes both directions for round-trip structured searches', () => {
  const criteria = normalizeGoogleFlightsSearchCriteria({
    origin: 'JFK',
    destination: 'LAX',
    departureDate: '2099-08-10',
    returnDate: '2099-08-17',
    tripType: 'round-trip',
    adults: 1,
    cabinClass: 'economy',
  }, new Date('2099-01-01T00:00:00Z'));
  const url = buildGoogleFlightsSearchUrl(criteria);
  const decodedText = Buffer.from(url.searchParams.get('tfs') ?? '', 'base64url').toString('utf8');
  const fields = outerVarints(url);
  assert.match(decodedText, /2099-08-10/);
  assert.match(decodedText, /2099-08-17/);
  assert.equal((decodedText.match(/JFK/g) ?? []).length, 2);
  assert.equal((decodedText.match(/LAX/g) ?? []).length, 2);
  assert.deepEqual(fields.get(2), [0]);
  assert.deepEqual(fields.get(19), [1]);
});

test('rejects invalid structured search criteria', () => {
  const now = new Date('2099-01-01T00:00:00Z');
  const valid = {
    origin: 'JFK',
    destination: 'LAX',
    departureDate: '2099-08-10',
    returnDate: '2099-08-17',
    tripType: 'round-trip',
    adults: 1,
    cabinClass: 'economy',
  };
  assert.throws(() => normalizeGoogleFlightsSearchCriteria({ ...valid, origin: 'New York' }, now), /IATA/);
  assert.throws(() => normalizeGoogleFlightsSearchCriteria({ ...valid, destination: 'JFK' }, now), /different/);
  assert.throws(() => normalizeGoogleFlightsSearchCriteria({ ...valid, departureDate: '2000-01-01' }, now), /past/);
  assert.throws(() => normalizeGoogleFlightsSearchCriteria({ ...valid, returnDate: '2099-08-01' }, now), /before/);
  assert.throws(() => normalizeGoogleFlightsSearchCriteria({ ...valid, adults: 10 }, now), /1 to 9/);
  assert.throws(() => normalizeGoogleFlightsSearchCriteria({ ...valid, cabinClass: 'coach' }, now), /cabinClass/);
  assert.throws(() => normalizeGoogleFlightsSearchCriteria({ ...valid, tripType: 'multi-city' }, now), /tripType/);
});

test('parses, groups, normalizes, deduplicates, and links Google Flights entries', () => {
  const data = parseGoogleFlightsSearchHtml(
    fixture,
    'https://www.google.com/travel/flights/search?tfs=CBwQAhojEgoyMDI2LTEwLTE5agwIAhIIL20vMDEzeXFyBwgBEgNNU1BAAUgBcAGCAQsI____________AZgBAg',
  );

  assert.equal(data.pageTitle, 'Atlanta to Minneapolis | Google Flights');
  assert.equal(data.tripType, 'One way');
  assert.equal(data.cabinClass, 'Economy (include Basic)');
  assert.equal(data.passengerCount, 1);
  assert.equal(data.departureDate, '2026-10-19');
  assert.deepEqual(data.summary, {
    total: 2,
    topCount: 1,
    otherCount: 1,
    lowestPrice: 149,
    lowestPriceDisplay: '$149',
    priceInsight: 'Prices are currently high',
  });

  const [top, other] = data.flights;
  assert.ok(top);
  assert.equal(top.group, 'top');
  assert.deepEqual(top.airlines, ['Frontier']);
  assert.equal(top.departure.code, 'ATL');
  assert.equal(top.arrival.code, 'MSP');
  assert.equal(top.departure.localDateTime, '2026-10-19T13:36:00');
  assert.equal(top.durationMinutes, 162);
  assert.equal(top.stops, 0);
  assert.equal(top.price.amount, 149);
  assert.equal(top.baggage.carryOnIncluded, 0);
  assert.equal(top.emissions.kilogramsCo2e, 108);
  assert.equal(top.emissions.differencePercent, -46);
  assert.ok(top.detailsUrl);
  const topDetailsUrl = new URL(top.detailsUrl);
  assert.equal(topDetailsUrl.pathname, '/travel/flights/booking');
  const topTfs = Buffer.from(topDetailsUrl.searchParams.get('tfs') ?? '', 'base64url').toString('utf8');
  const topTfu = Buffer.from(topDetailsUrl.searchParams.get('tfu') ?? '', 'base64url').toString('utf8');
  assert.match(topTfs, /ATL/);
  assert.match(topTfs, /MSP/);
  assert.match(topTfs, /F9/);
  assert.match(topTfs, /3045/);
  assert.match(topTfu, /CjRIbmNqOV/);

  assert.ok(other);
  assert.equal(other.group, 'other');
  assert.deepEqual(other.airlines, ['Delta', 'United']);
  assert.equal(other.arrival.localDate, '2026-10-20');
  assert.equal(other.arrival.localDateTime, '2026-10-20T00:15:00');
  assert.equal(other.price.status, 'unavailable');
  assert.equal(other.price.amount, null);
  assert.equal(other.stops, 1);
  assert.equal(other.layovers[0]?.durationMinutes, 55);
  assert.equal(other.baggage.checkedIncluded, 1);
  assert.equal(other.emissions.differencePercent, null);
  assert.ok(other.detailsUrl);
  const otherTfs = Buffer.from(new URL(other.detailsUrl).searchParams.get('tfs') ?? '', 'base64url').toString('utf8');
  assert.match(otherTfs, /ATL/);
  assert.match(otherTfs, /ORD/);
  assert.match(otherTfs, /MSP/);
  assert.match(otherTfs, /111/);
  assert.match(otherTfs, /222/);
});

test('keeps optional fields null when the page omits them', () => {
  const data = parseGoogleFlightsSearchHtml(
    fixture.replace(/<button aria-label="Carbon emissions estimate:[^"]+"><\/button>/g, ''),
  );
  assert.equal(data.flights[0]?.emissions.display, null);
  assert.equal(data.flights[0]?.emissions.differencePercent, null);
});

test('recognizes search and booking URLs without accepting unrelated URLs', () => {
  assert.equal(
    canHandleGoogleFlightsUrl(new URL('https://www.google.com/travel/flights/search?tfs=abc')),
    'search',
  );
  assert.equal(
    canHandleGoogleFlightsUrl(new URL('https://www.google.com/travel/flights/booking?tfs=abc')),
    'booking',
  );
  assert.equal(canHandleGoogleFlightsUrl(new URL('https://www.google.com/travel/flights')), null);
  assert.equal(canHandleGoogleFlightsUrl(new URL('https://example.com/travel/flights/search?tfs=abc')), null);
});

test('rejects booking details before making a network request', async () => {
  await assert.rejects(
    extractGoogleFlightsSearch({ url: 'https://www.google.com/travel/flights/booking?tfs=abc' }),
    /booking detail pages are not supported yet/,
  );
});

test('distinguishes a loading shell from a parsed empty page', () => {
  assert.throws(
    () => parseGoogleFlightsSearchHtml('<html><body>Loading results</body></html>'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'REMOTE_BLOCKED',
  );
  assert.throws(
    () => parseGoogleFlightsSearchHtml('<html><body>No matching flights</body></html>'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PARSE_FAILED',
  );
});
