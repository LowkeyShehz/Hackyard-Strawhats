/**
 * Nirman Mitra — HTTP server (Render web service, and local runs)
 * Runs the Lambda handlers unchanged in one long-lived Node process:
 *   GET|POST /webhook/whatsapp → messageHandler
 *   *        /api/*            → adminApi
 *   GET      /files/<bucket>/<key>?exp&sig → stored files behind signed, expiring links
 *            (disk storage only; these stand in for S3 pre-signed URLs)
 *   GET      /health           → liveness check for Render
 * Each request is turned into an API Gateway REST (v1) proxy event, and the handler's
 * { statusCode, headers, body } result is written back as the HTTP response.
 */

import http from 'http';
import { pathToFileURL } from 'url';
import config, { apiResponse } from './utils/config.js';
import { contentTypeFor, verifyFileLink, readStoredFile, pruneOldMedia } from './utils/s3.js';
import { handler as messageHandler, drainBackgroundWork } from './handlers/messageHandler.js';
import { handler as adminApiHandler } from './handlers/adminApi.js';

// API Gateway's payload limit; WhatsApp and dashboard requests are far smaller
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function routeFor(path) {
  if (path === '/webhook/whatsapp') return messageHandler;
  if (path.startsWith('/api/')) return adminApiHandler;
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The API Gateway REST (v1) proxy event the handlers expect */
export function toApiGatewayEvent(req, url, body) {
  const query = Object.fromEntries(url.searchParams);
  return {
    httpMethod: req.method,
    path: url.pathname,
    headers: { ...req.headers },
    queryStringParameters: Object.keys(query).length > 0 ? query : null,
    pathParameters: null,
    body: body || null,
    isBase64Encoded: false,
    requestContext: { requestId: req.headers['x-request-id'] || '', http: { method: req.method } },
  };
}

/** GET /files/<bucket>/<key...>: a file from disk storage, if the link is signed and unexpired */
async function serveFile(req, res, url) {
  if (config.storageBackend !== 'disk' || req.method !== 'GET') return send(res, apiResponse(404, { error: 'Not found' }));
  let segments;
  try {
    segments = url.pathname.split('/').slice(2).map(decodeURIComponent);
  } catch {
    return send(res, apiResponse(400, { error: 'Bad path' }));
  }
  const [bucket, ...rest] = segments;
  const key = rest.join('/');
  if (!bucket || !key || !verifyFileLink(bucket, key, url.searchParams.get('exp'), url.searchParams.get('sig'))) {
    return send(res, apiResponse(403, { error: 'Invalid or expired link' }));
  }
  const file = await readStoredFile(bucket, key);
  if (!file) return send(res, apiResponse(404, { error: 'Not found' }));
  res.writeHead(200, { 'Content-Type': contentTypeFor(key), 'Content-Length': file.length, 'Cache-Control': 'private, max-age=300' });
  return res.end(file);
}

function send(res, result) {
  const { statusCode = 200, headers = {}, body = '', isBase64Encoded = false } = result || {};
  res.writeHead(statusCode, headers);
  res.end(isBase64Encoded ? Buffer.from(body, 'base64') : body);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/health') return send(res, apiResponse(200, { ok: true }));
      if (path.startsWith('/files/')) return await serveFile(req, res, url);

      const route = routeFor(path);
      if (!route) return send(res, apiResponse(404, { error: 'Not found' }));

      const body = await readBody(req);
      return send(res, await route(toApiGatewayEvent(req, url, body)));
    } catch (err) {
      if (err.statusCode === 413) return send(res, apiResponse(413, { error: 'Payload too large' }));
      if (err.name === 'InvalidPath') return send(res, apiResponse(400, { error: 'Bad path' }));
      console.error(`Server error on ${req.method} ${path}:`, err);
      return send(res, apiResponse(500, { error: 'Internal server error' }));
    }
  });
}

/** Stop taking requests, let background webhook work finish, then exit (Render sends SIGTERM on deploy) */
function shutdown(server, signal) {
  console.log(`${signal} received — draining`);
  server.close();
  drainBackgroundWork().finally(() => process.exit(0));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = parseInt(process.env.PORT || '3001', 10);
  const server = createServer();
  server.listen(port, () => console.log(`Nirman Mitra API listening on :${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => shutdown(server, signal));

  // Raw worker media expires after 90 days, as the S3 lifecycle rule did (disk storage only)
  const prune = () => pruneOldMedia(90)
    .then((n) => n && console.log(`Pruned ${n} raw media file(s) older than 90 days`))
    .catch((err) => console.error('Media prune failed:', err.message));
  prune();
  setInterval(prune, 24 * 60 * 60 * 1000).unref();
}
