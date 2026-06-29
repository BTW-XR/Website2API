# Website to API

A local Fastify + TypeScript demo that turns supported website pages into structured JSON.

Supported providers:

- Amazon search pages and product pages
- YouTube search pages and watch pages

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
