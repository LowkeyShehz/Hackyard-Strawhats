/**
 * Nirman Mitra — HTTP server (Render web service, and local runs)
 * Runs the Lambda handlers unchanged in one long-lived Node process:
 *   GET|POST /webhook/whatsapp → messageHandler
 *   *        /api/*            → adminApi
 *   GET      /health           → liveness check for Render
 * Each request is turned into an API Gateway REST (v1) proxy event, and the handler's
 * { statusCode, headers, body } result is written back as the HTTP response.
 */

import http from 'http';
import { pathToFileURL } from 'url';
import { apiResponse } from './utils/config.js';
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

      const route = routeFor(path);
      if (!route) return send(res, apiResponse(404, { error: 'Not found' }));

      const body = await readBody(req);
      return send(res, await route(toApiGatewayEvent(req, url, body)));
    } catch (err) {
      if (err.statusCode === 413) return send(res, apiResponse(413, { error: 'Payload too large' }));
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
}
