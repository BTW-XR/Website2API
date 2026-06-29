import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { ExtractError, type ExtractFailure, type ExtractRequest } from './core/types.js';
import { extract } from './providers/index.js';

const app = Fastify({ logger: true });
const indexHtml = await readFile(new URL('./web/index.html', import.meta.url), 'utf8');
const CORS_ALLOW_METHODS = 'POST, OPTIONS';
const CORS_ALLOW_HEADERS = 'Content-Type, Authorization';

function isExtractRoute(url: string): boolean {
  return url.split('?')[0] === '/api/extract';
}

function isAllowedCorsOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string') {
    return false;
  }

  try {
    const url = new URL(origin);
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}

function applyCorsHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const origin = request.headers.origin;
  if (!isAllowedCorsOrigin(origin)) {
    return false;
  }

  reply
    .header('Access-Control-Allow-Origin', origin)
    .header('Access-Control-Allow-Methods', CORS_ALLOW_METHODS)
    .header('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS)
    .header('Vary', 'Origin');
  return true;
}

function failureFromError(error: unknown): { statusCode: number; body: ExtractFailure } {
  if (error instanceof ExtractError) {
    return {
      statusCode: error.statusCode,
      body: { ok: false, code: error.code, error: error.message },
    };
  }

  const message = error instanceof Error ? error.message : 'Extraction failed';
  return {
    statusCode: 500,
    body: { ok: false, code: 'EXTRACT_FAILED', error: message },
  };
}

app.addHook('onRequest', async (request, reply) => {
  if (isExtractRoute(request.url)) {
    applyCorsHeaders(request, reply);
  }
});

app.get('/', async (_request, reply) => {
  return reply.type('text/html; charset=utf-8').send(indexHtml);
});

app.options('/api/extract', async (request, reply) => {
  if (!applyCorsHeaders(request, reply) && typeof request.headers.origin === 'string') {
    return reply.code(403).send({
      ok: false,
      code: 'CORS_FORBIDDEN',
      error: 'Origin is not allowed.',
    });
  }

  return reply.code(204).send();
});

app.post<{ Body: ExtractRequest }>('/api/extract', async (request, reply) => {
  try {
    return await extract(request.body ?? {});
  } catch (error) {
    const failure = failureFromError(error);
    request.log.warn({ error }, 'extract request failed');
    return reply.code(failure.statusCode).send(failure.body);
  }
});

const parsedPort = Number.parseInt(process.env['PORT'] ?? '', 10);
const port = Number.isFinite(parsedPort) ? parsedPort : 3040;

await app.listen({ port, host: '127.0.0.1' });
