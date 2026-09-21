#!/usr/bin/env node

import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { codexTracePath } from '../../dist/codex-trace.js';

const root = dirname(fileURLToPath(import.meta.url));
const port = readPort(process.argv, process.env.FAST_JEV_VIEWER_PORT || '4317');
const host = process.env.FAST_JEV_VIEWER_HOST || '127.0.0.1';
const tracePath = codexTracePath(process.env);
const maxEvents = 1_000;

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function readPort(argumentsList, fallback) {
  const index = argumentsList.indexOf('--port');
  const value = index >= 0 ? argumentsList[index + 1] : fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`invalid port: ${value}`);
  }
  return parsed;
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(response, status, body, contentType) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readEvents() {
  try {
    const text = await readFile(tracePath, 'utf8');
    const events = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event && typeof event === 'object' && typeof event.id === 'string') {
          events.push(event);
        }
      } catch {
        // A partially written final line is ignored until the next poll.
      }
    }
    return events.slice(-maxEvents);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function traceMetadata() {
  try {
    const details = await stat(tracePath);
    return { updatedAt: details.mtime.toISOString(), size: details.size };
  } catch (error) {
    if (error?.code === 'ENOENT') return { updatedAt: null, size: 0 };
    throw error;
  }
}

async function serveAsset(response, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'styles.css'].includes(relativePath)) {
    sendText(response, 404, 'Not found\n', 'text/plain; charset=utf-8');
    return;
  }
  const body = await readFile(join(root, relativePath));
  sendText(
    response,
    200,
    body,
    contentTypes[extname(relativePath)] || 'application/octet-stream',
  );
}

async function handle(request, response) {
  const url = new URL(request.url || '/', `http://${host}:${port}`);
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');

  if (url.pathname === '/api/health' && request.method === 'GET') {
    sendJson(response, 200, { ok: true, traceFile: tracePath });
    return;
  }

  if (url.pathname === '/api/events' && request.method === 'GET') {
    const [events, metadata] = await Promise.all([readEvents(), traceMetadata()]);
    sendJson(response, 200, {
      events,
      eventCount: events.length,
      traceFile: tracePath,
      ...metadata,
    });
    return;
  }

  if (url.pathname === '/api/clear' && request.method === 'POST') {
    await mkdir(dirname(tracePath), { recursive: true });
    await writeFile(tracePath, '', 'utf8');
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'GET') {
    await serveAsset(response, url.pathname);
    return;
  }

  sendText(response, 405, 'Method not allowed\n', 'text/plain; charset=utf-8');
}

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error(error);
    sendJson(response, 500, { error: 'viewer server error' });
  });
});

server.listen(port, host, () => {
  console.log(`fast-jev-codex web viewer listening at http://${host}:${port}`);
  console.log(`trace file: ${tracePath}`);
});
