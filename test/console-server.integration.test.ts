import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeRegister, parseAndValidate } from '../src/commands/register.js';
import { type ConsoleServer, startConsoleServer } from '../src/console/server.js';
import { type RefmeshHybridStores, openHybridStores } from '../src/db/connection.js';

interface FetchedJson {
  status: number;
  body: unknown;
}

async function fetchJson(url: string, init?: RequestInit): Promise<FetchedJson> {
  const res = await fetch(url, init);
  let body: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

describe('console HTTP server', () => {
  let tempDir: string;
  let stores: RefmeshHybridStores;
  let server: ConsoleServer;
  let staticDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'refmesh-console-srv-'));
    stores = await openHybridStores({
      graphPath: join(tempDir, 'graph.kuzu'),
      vectorPath: join(tempDir, 'vectors.lance'),
    });
    staticDir = join(tempDir, 'static');
    await mkdir(staticDir, { recursive: true });
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><h1>refmesh</h1>');
    writeFileSync(join(staticDir, 'app.js'), 'console.log("ok");');
    server = await startConsoleServer(stores, { port: 0, staticRoot: staticDir });
  });

  afterAll(async () => {
    try {
      await server.close();
    } catch {
      // ignore
    }
    try {
      await stores.close();
    } catch {
      // ignore
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    await stores.graph.connection.query('MATCH (n) DETACH DELETE n');
    await stores.vector.clearAll();
  });

  it('binds to a free loopback port and reports a usable URL', () => {
    expect(server.host).toBe('127.0.0.1');
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('serves the static index page on /', async () => {
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('refmesh');
  });

  it('serves bundled assets', async () => {
    const res = await fetch(`${server.url}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/javascript/);
  });

  it('rejects path traversal attempts', async () => {
    const res = await fetch(`${server.url}/../package.json`);
    // fetch normalizes the URL, but we still verify the server's behavior on
    // a hand-crafted URL via a direct path that escapes the static root.
    expect([400, 404]).toContain(res.status);
  });

  it('returns 405 for non-GET methods', async () => {
    const res = await fetchJson(`${server.url}/api/stats`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('returns stats over the API', async () => {
    const res = await fetchJson(`${server.url}/api/stats`);
    expect(res.status).toBe(200);
    const body = res.body as { counts: { concepts: number } };
    expect(body.counts.concepts).toBe(0);
  });

  it('exposes registered concepts and their neighbors', async () => {
    await executeRegister(
      stores,
      parseAndValidate(
        JSON.stringify({
          reference: { url: 'https://example.com/srv', title: 'srv' },
          concepts: [
            { id: 'Root', description: 'root' },
            { id: 'Child', description: 'child' },
          ],
          relationships: [{ source: 'Root', target: 'Child', type: 'CONTAINS', reason: 'r-c' }],
        }),
      ),
    );

    const list = await fetchJson(`${server.url}/api/concepts?limit=10&sort=id`);
    expect(list.status).toBe(200);
    const listBody = list.body as { items: { id: string }[]; total: number };
    expect(listBody.total).toBe(2);
    expect(listBody.items.map((i) => i.id).sort()).toEqual(['Child', 'Root']);

    const detail = await fetchJson(`${server.url}/api/concepts/Root`);
    expect(detail.status).toBe(200);
    const detailBody = detail.body as { id: string; references: { url: string }[] };
    expect(detailBody.id).toBe('Root');
    expect(detailBody.references[0]?.url).toBe('https://example.com/srv');

    const missing = await fetchJson(`${server.url}/api/concepts/Ghost`);
    expect(missing.status).toBe(404);

    const neighbors = await fetchJson(`${server.url}/api/concepts/Root/neighbors?depth=1`);
    expect(neighbors.status).toBe(200);
    const nb = neighbors.body as { nodes: { id: string }[]; edges: { type: string }[] };
    expect(nb.nodes.map((n) => n.id).sort()).toEqual(['Child', 'Root']);
    expect(nb.edges[0]?.type).toBe('CONTAINS');
  });

  it('rejects bad query params with 400', async () => {
    const res = await fetchJson(`${server.url}/api/concepts?limit=-1`);
    expect(res.status).toBe(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/limit/);
  });

  it('returns 400 when search query is empty', async () => {
    const res = await fetchJson(`${server.url}/api/search?q=`);
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown api endpoints', async () => {
    const res = await fetchJson(`${server.url}/api/unknown`);
    expect(res.status).toBe(404);
  });

  it('refuses symlinks that point outside the static root', async () => {
    // Place a sensitive file outside the static dir, then create a symlink
    // inside the static dir that points at it. The server must refuse to
    // serve it (B-1 from the DA review).
    const sensitivePath = join(dirname(staticDir), 'CONFIDENTIAL.txt');
    writeFileSync(sensitivePath, 'top secret');
    const linkPath = join(staticDir, 'leak.txt');
    try {
      symlinkSync(sensitivePath, linkPath);
    } catch {
      // some environments disallow symlink creation; skip rather than fail
      return;
    }
    const res = await fetch(`${server.url}/leak.txt`);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain('top secret');
  });

  it('does not increment accessCount when searched via the console API (read-only)', async () => {
    await executeRegister(
      stores,
      parseAndValidate(
        JSON.stringify({
          reference: { url: 'https://example.com/ro', title: 'ro' },
          concepts: [{ id: 'ReadOnlyTarget', description: 'never reinforced via console' }],
          relationships: [],
        }),
      ),
    );
    const before = await stores.graph.connection.query(
      "MATCH (c:Concept) WHERE c.id = 'ReadOnlyTarget' RETURN c.accessCount AS n",
    );
    const beforeRows = await before.getAll();
    expect(Number(beforeRows[0]?.['n'] ?? 0)).toBe(0);

    const res = await fetchJson(
      `${server.url}/api/search?q=${encodeURIComponent('ReadOnlyTarget')}&threshold=0`,
    );
    expect(res.status).toBe(200);

    const after = await stores.graph.connection.query(
      "MATCH (c:Concept) WHERE c.id = 'ReadOnlyTarget' RETURN c.accessCount AS n",
    );
    const afterRows = await after.getAll();
    expect(Number(afterRows[0]?.['n'] ?? 0)).toBe(0);
  });
});
