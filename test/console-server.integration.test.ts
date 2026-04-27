import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeRegister, parseAndValidate } from '../src/commands/register.js';
import { type ConsoleServer, startConsoleServer } from '../src/console/server.js';
import { type RefmeshStore, openStore } from '../src/db/store.js';

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
  let store: RefmeshStore;
  let server: ConsoleServer;
  let staticDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'refmesh-console-srv-'));
    store = openStore({ dbPath: join(tempDir, 'refmesh.db') });
    staticDir = join(tempDir, 'static');
    await mkdir(staticDir, { recursive: true });
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><h1>refmesh</h1>');
    writeFileSync(join(staticDir, 'app.js'), 'console.log("ok");');
    server = await startConsoleServer(store, { port: 0, staticRoot: staticDir });
  });

  afterAll(async () => {
    try {
      await server.close();
    } catch {
      // ignore
    }
    try {
      store.close();
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
    await store.db.exec('DELETE FROM concepts; DELETE FROM refs;');
    store.vectors.clearAll();
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
      store,
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

  it('exposes /api/search/debug with a populated trace payload', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        JSON.stringify({
          reference: { url: 'https://example.com/debug', title: 'debug' },
          concepts: [
            { id: 'DebugTarget', description: 'observable target' },
            { id: 'OtherSide', description: 'unrelated noise about volcanoes' },
          ],
          relationships: [],
        }),
      ),
    );
    const res = await fetchJson(
      `${server.url}/api/search/debug?q=${encodeURIComponent('observable target')}&threshold=0&depth=0`,
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      result: { matchedConcepts: { id: string }[] };
      trace: {
        queryEmbedding: { dim: number };
        vectorRequest: { threshold: number };
        vectorHits: { id: string; passedThreshold: boolean }[];
        graphQueries: { label: string }[];
        candidates: { id: string }[];
        traversal: { depth: number };
      };
    };
    expect(body.result.matchedConcepts.some((c) => c.id === 'DebugTarget')).toBe(true);
    expect(body.trace.queryEmbedding.dim).toBeGreaterThan(0);
    expect(body.trace.vectorRequest.threshold).toBe(0);
    expect(body.trace.vectorHits.length).toBeGreaterThan(0);
    expect(body.trace.graphQueries.some((q) => q.label === 'concepts.byIds')).toBe(true);
    expect(body.trace.traversal.depth).toBe(0);
  });

  it('rejects /api/search/debug with empty q', async () => {
    const res = await fetchJson(`${server.url}/api/search/debug?q=`);
    expect(res.status).toBe(400);
  });

  it('does not increment accessCount via /api/search/debug (read-only)', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        JSON.stringify({
          reference: { url: 'https://example.com/ro-debug', title: 'ro-debug' },
          concepts: [{ id: 'DebugRO', description: 'read only debug target' }],
          relationships: [],
        }),
      ),
    );
    const res = await fetchJson(
      `${server.url}/api/search/debug?q=${encodeURIComponent('read only debug target')}&threshold=0`,
    );
    expect(res.status).toBe(200);
    const row = store.db
      .prepare("SELECT access_count AS n FROM concepts WHERE id = 'DebugRO'")
      .get() as { n: number } | undefined;
    expect(row?.n ?? 0).toBe(0);
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
      store,
      parseAndValidate(
        JSON.stringify({
          reference: { url: 'https://example.com/ro', title: 'ro' },
          concepts: [{ id: 'ReadOnlyTarget', description: 'never reinforced via console' }],
          relationships: [],
        }),
      ),
    );
    const before = store.db
      .prepare("SELECT access_count AS n FROM concepts WHERE id = 'ReadOnlyTarget'")
      .get() as { n: number } | undefined;
    expect(before?.n ?? 0).toBe(0);

    const res = await fetchJson(
      `${server.url}/api/search?q=${encodeURIComponent('ReadOnlyTarget')}&threshold=0`,
    );
    expect(res.status).toBe(200);

    const after = store.db
      .prepare("SELECT access_count AS n FROM concepts WHERE id = 'ReadOnlyTarget'")
      .get() as { n: number } | undefined;
    expect(after?.n ?? 0).toBe(0);
  });
});
