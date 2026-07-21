# Website to API

A local Fastify + TypeScript demo that turns supported website pages into structured JSON.

Supported providers:

- Amazon search pages and product pages
- YouTube search pages and watch pages
- Google Flights search result pages

## Setup

```bash
npm install
npm run dev
```

The server starts on `http://127.0.0.1:3040` by default. Override it with `PORT=xxxx`.

## API

```http
POST /api/extract
Content-Type: application/json
```

URL extraction:

```json
{ "url": "https://www.youtube.com/watch?v=p6ouOSg3mP0" }
```

Google Flights accepts `/travel/flights/search` URLs. Each search entry includes a `detailsUrl`
that opens Google's original booking page; extracting booking-page details is not supported.

Google Flights also accepts structured searches:

```json
{
  "provider": "google-flights",
  "type": "search",
  "origin": "JFK",
  "destination": "LAX",
  "departureDate": "2026-08-10",
  "returnDate": "2026-08-17",
  "tripType": "round-trip",
  "adults": 1,
  "cabinClass": "economy"
}
```

`tripType` is `one-way` or `round-trip`; `cabinClass` is `economy`,
`premium-economy`, `business`, or `first`. Airports use three-letter IATA
codes. Structured responses include the normalized request as
`data.searchCriteria`. One-way requests omit `returnDate`.

Provider search:

```json
{ "provider": "amazon", "type": "search", "query": "cat" }
```

Successful responses use this shape:

```json
{
  "ok": true,
  "provider": "youtube",
  "type": "video",
  "sourceUrl": "https://www.youtube.com/watch?v=p6ouOSg3mP0",
  "data": {}
}
```

Failures are normalized:

```json
{ "ok": false, "error": "Unsupported URL", "code": "UNSUPPORTED_INPUT" }
```

## Notes

This project does not use API keys, browser automation, CAPTCHA bypassing, login bypassing, or private endpoints. It parses public HTML and embedded page data with Cheerio.
