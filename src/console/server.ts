import { createReadStream, realpathSync, statSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RefmeshHybridStores } from '../db/connection.js';
import { RefmeshRuntimeError, RefmeshValidationError } from '../util/errors.js';
import {
  getConcept,
  getNeighbors,
  getStats,
  listConcepts,
  parseConsoleSearchOptions,
  parseListConceptsOptions,
  parseNeighborsOptions,
  runConsoleSearch,
} from './handlers.js';

export interface ConsoleServerOptions {
  port?: number;
  host?: string;
  staticRoot?: string;
}

export interface ConsoleServer {
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

const ALLOWED_METHODS = new Set(['GET', 'HEAD']);
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function defaultStaticRoot(): string {
  // Two layouts to support: production (this file at dist/console/server.js)
  // expects assets at dist/console-ui/, while dev (tsx running src/console/server.ts)
  // expects them at <repo>/dist/console-ui/. Probe both before failing.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '..', 'console-ui'), join(here, '..', '..', 'dist', 'console-ui')];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // try next
    }
  }
  return candidates[0] as string;
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(payload);
}

function sendError(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  message: string,
): void {
  sendJson(req, res, status, { error: message });
}

function extOf(path: string): string {
  const idx = path.lastIndexOf('.');
  return idx < 0 ? '' : path.slice(idx).toLowerCase();
}

function serveStatic(req: IncomingMessage, res: ServerResponse, root: string): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const safe = normalize(pathname).replace(/^([/\\])+/, '');
  if (safe.includes('..')) {
    sendError(req, res, 400, 'invalid path');
    return;
  }
  const filePath = join(root, safe);

  // Resolve symlinks on both sides and require the real file path to live
  // under the real static root. Without this a symlink dropped into the
  // bundle directory would let an attacker read arbitrary files.
  let realRoot: string;
  let realPath: string;
  try {
    realRoot = realpathSync(root);
    realPath = realpathSync(filePath);
  } catch {
    sendError(req, res, 404, 'not found');
    return;
  }
  const rootPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (realPath !== realRoot && !realPath.startsWith(rootPrefix)) {
    sendError(req, res, 403, 'forbidden');
    return;
  }

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(realPath);
  } catch {
    sendError(req, res, 404, 'not found');
    return;
  }
  if (!st.isFile()) {
    sendError(req, res, 404, 'not found');
    return;
  }

  const mime = MIME[extOf(realPath)] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(realPath).pipe(res);
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? '';
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return true;
  return false;
}

export async function handleApiRequest(
  stores: RefmeshHybridStores,
  pathname: string,
  search: URLSearchParams,
): Promise<{ status: number; body: unknown }> {
  try {
    if (pathname === '/api/stats') {
      return { status: 200, body: await getStats(stores) };
    }
    if (pathname === '/api/concepts') {
      const opts = parseListConceptsOptions(search);
      return { status: 200, body: await listConcepts(stores, opts) };
    }
    const conceptMatch = pathname.match(/^\/api\/concepts\/([^/]*)(?:\/(neighbors))?\/?$/);
    if (conceptMatch) {
      const id = decodeURIComponent(conceptMatch[1] ?? '');
      // Treat blank ids (e.g. "%20") the same as missing ids — Concept ids
      // must carry meaningful content per the register schema.
      if (id.trim().length === 0) {
        return { status: 400, body: { error: 'concept id must not be empty' } };
      }
      const sub = conceptMatch[2];
      if (sub === 'neighbors') {
        const opts = parseNeighborsOptions(search);
        const result = await getNeighbors(stores, id, opts);
        if (!result) return { status: 404, body: { error: `concept not found: ${id}` } };
        return { status: 200, body: result };
      }
      const detail = await getConcept(stores, id);
      if (!detail) return { status: 404, body: { error: `concept not found: ${id}` } };
      return { status: 200, body: detail };
    }
    if (pathname === '/api/search') {
      const opts = parseConsoleSearchOptions(search);
      return { status: 200, body: await runConsoleSearch(stores, opts) };
    }
    return { status: 404, body: { error: 'unknown api endpoint' } };
  } catch (err) {
    if (err instanceof RefmeshValidationError) {
      return { status: 400, body: { error: err.message } };
    }
    if (err instanceof RefmeshRuntimeError) {
      return { status: 500, body: { error: err.message } };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 500, body: { error: `internal error: ${msg}` } };
  }
}

export async function startConsoleServer(
  stores: RefmeshHybridStores,
  options: ConsoleServerOptions = {},
): Promise<ConsoleServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const staticRoot = options.staticRoot ?? defaultStaticRoot();

  const server: Server = createServer(async (req, res) => {
    try {
      if (!ALLOWED_METHODS.has(req.method ?? '')) {
        sendError(req, res, 405, 'method not allowed');
        return;
      }
      if (!isLoopbackRequest(req)) {
        sendError(req, res, 403, 'forbidden: loopback only');
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const { status, body } = await handleApiRequest(stores, url.pathname, url.searchParams);
        sendJson(req, res, status, body);
        return;
      }
      serveStatic(req, res, staticRoot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendError(req, res, 500, `internal error: ${msg}`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListen);
      reject(err);
    };
    const onListen = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(port, host);
  });

  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new RefmeshRuntimeError('failed to bind console server');
  }
  const boundPort = addr.port;
  const url = `http://${host}:${boundPort}`;

  return {
    url,
    port: boundPort,
    host,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
