import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeRegister, parseAndValidate } from '../src/commands/register.js';
import { type RefmeshHybridStores, openHybridStores } from '../src/db/connection.js';
import { RefmeshValidationError } from '../src/util/errors.js';

function payload(refOverrides: Record<string, unknown>) {
  return JSON.stringify({
    reference: { url: 'https://example.com/freshness', title: 'doc', ...refOverrides },
    concepts: [{ id: 'Alpha', description: 'first concept' }],
    relationships: [],
  });
}

async function getConcept(stores: RefmeshHybridStores, id: string) {
  const res = await stores.graph.connection.prepare(
    `MATCH (c:Concept) WHERE c.id = $id
     RETURN c.firstSeenAt AS firstSeenAt, c.lastSeenAt AS lastSeenAt,
            c.touchCount AS touchCount, c.accessCount AS accessCount,
            c.archivedAt AS archivedAt`,
  );
  const rows = await (await stores.graph.connection.execute(res, { id })).getAll();
  return rows[0] as Record<string, unknown> | undefined;
}

async function getReference(stores: RefmeshHybridStores, url: string) {
  const res = await stores.graph.connection.prepare(
    `MATCH (r:Reference) WHERE r.url = $url
     RETURN r.firstSeenAt AS firstSeenAt, r.lastSeenAt AS lastSeenAt,
            r.publishedAt AS publishedAt, r.fetchedAt AS fetchedAt`,
  );
  const rows = await (await stores.graph.connection.execute(res, { url })).getAll();
  return rows[0] as Record<string, unknown> | undefined;
}

describe('freshness metadata (PBI-8)', () => {
  let tempDir: string;
  let stores: RefmeshHybridStores;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'refmesh-fresh-'));
    stores = await openHybridStores({
      graphPath: join(tempDir, 'graph.kuzu'),
      vectorPath: join(tempDir, 'vectors.lance'),
    });
  });

  afterAll(async () => {
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

  it('initializes firstSeenAt/lastSeenAt/touchCount on first register', async () => {
    await executeRegister(stores, parseAndValidate(payload({})));
    const c = await getConcept(stores, 'Alpha');
    expect(c).toBeDefined();
    expect(c!.firstSeenAt).toBeInstanceOf(Date);
    expect(c!.lastSeenAt).toBeInstanceOf(Date);
    expect((c!.firstSeenAt as Date).getTime()).toBe((c!.lastSeenAt as Date).getTime());
    expect(c!.touchCount).toBe(1);
    expect(c!.accessCount).toBe(0);
    expect(c!.archivedAt).toBeNull();
  });

  it('updates lastSeenAt and increments touchCount on re-register, keeping firstSeenAt', async () => {
    await executeRegister(stores, parseAndValidate(payload({})));
    const before = await getConcept(stores, 'Alpha');
    await new Promise((r) => setTimeout(r, 1100));
    await executeRegister(stores, parseAndValidate(payload({})));
    const after = await getConcept(stores, 'Alpha');

    expect((after!.firstSeenAt as Date).getTime()).toBe((before!.firstSeenAt as Date).getTime());
    expect((after!.lastSeenAt as Date).getTime()).toBeGreaterThanOrEqual(
      (before!.lastSeenAt as Date).getTime(),
    );
    expect(after!.touchCount).toBe(2);
  });

  it('persists reference.publishedAt when provided', async () => {
    await executeRegister(
      stores,
      parseAndValidate(payload({ publishedAt: '2026-01-01T00:00:00Z' })),
    );
    const r = await getReference(stores, 'https://example.com/freshness');
    expect(r!.publishedAt).toBeInstanceOf(Date);
    expect((r!.publishedAt as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(r!.fetchedAt).toBeInstanceOf(Date);
    expect(r!.firstSeenAt).toBeInstanceOf(Date);
  });

  it('leaves reference.publishedAt NULL when omitted', async () => {
    await executeRegister(stores, parseAndValidate(payload({})));
    const r = await getReference(stores, 'https://example.com/freshness');
    expect(r!.publishedAt).toBeNull();
    expect(r!.fetchedAt).toBeInstanceOf(Date);
  });

  it('rejects invalid ISO date for publishedAt via JSON schema', () => {
    expect(() => parseAndValidate(payload({ publishedAt: 'not-a-date' }))).toThrow(
      RefmeshValidationError,
    );
  });
});
