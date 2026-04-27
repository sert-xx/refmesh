import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeRegister, parseAndValidate } from '../src/commands/register.js';
import { type RefmeshStore, openStore } from '../src/db/store.js';
import { RefmeshValidationError } from '../src/util/errors.js';

function payload(refOverrides: Record<string, unknown>) {
  return JSON.stringify({
    reference: { url: 'https://example.com/freshness', title: 'doc', ...refOverrides },
    concepts: [{ id: 'Alpha', description: 'first concept' }],
    relationships: [],
  });
}

interface ConceptMetaRow {
  first_seen_at: string;
  last_seen_at: string;
  touch_count: number;
  access_count: number;
  archived_at: string | null;
}

interface RefMetaRow {
  first_seen_at: string;
  last_seen_at: string;
  published_at: string | null;
  fetched_at: string | null;
}

function getConcept(store: RefmeshStore, id: string): ConceptMetaRow | undefined {
  return store.db
    .prepare<[string]>(
      `SELECT first_seen_at, last_seen_at, touch_count, access_count, archived_at
         FROM concepts WHERE id = ?`,
    )
    .get(id) as ConceptMetaRow | undefined;
}

function getReference(store: RefmeshStore, url: string): RefMetaRow | undefined {
  return store.db
    .prepare<[string]>(
      `SELECT first_seen_at, last_seen_at, published_at, fetched_at
         FROM refs WHERE url = ?`,
    )
    .get(url) as RefMetaRow | undefined;
}

describe('freshness metadata (PBI-8)', () => {
  let tempDir: string;
  let store: RefmeshStore;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'refmesh-fresh-'));
    store = openStore({ dbPath: join(tempDir, 'refmesh.db') });
  });

  afterAll(() => {
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

  beforeEach(() => {
    store.db.exec('DELETE FROM concepts; DELETE FROM refs;');
    store.vectors.clearAll();
  });

  it('initializes firstSeenAt/lastSeenAt/touchCount on first register', async () => {
    await executeRegister(store, parseAndValidate(payload({})));
    const c = getConcept(store, 'Alpha');
    expect(c).toBeDefined();
    expect(typeof c!.first_seen_at).toBe('string');
    expect(typeof c!.last_seen_at).toBe('string');
    expect(c!.first_seen_at).toBe(c!.last_seen_at);
    expect(c!.touch_count).toBe(1);
    expect(c!.access_count).toBe(0);
    expect(c!.archived_at).toBeNull();
  });

  it('updates lastSeenAt and increments touchCount on re-register, keeping firstSeenAt', async () => {
    await executeRegister(store, parseAndValidate(payload({})));
    const before = getConcept(store, 'Alpha');
    await new Promise((r) => setTimeout(r, 1100));
    await executeRegister(store, parseAndValidate(payload({})));
    const after = getConcept(store, 'Alpha');

    expect(after!.first_seen_at).toBe(before!.first_seen_at);
    expect(new Date(after!.last_seen_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before!.last_seen_at).getTime(),
    );
    expect(after!.touch_count).toBe(2);
  });

  it('persists reference.publishedAt when provided', async () => {
    await executeRegister(
      store,
      parseAndValidate(payload({ publishedAt: '2026-01-01T00:00:00Z' })),
    );
    const r = getReference(store, 'https://example.com/freshness');
    expect(r!.published_at).toBe('2026-01-01T00:00:00.000Z');
    expect(typeof r!.fetched_at).toBe('string');
    expect(typeof r!.first_seen_at).toBe('string');
  });

  it('leaves reference.publishedAt NULL when omitted', async () => {
    await executeRegister(store, parseAndValidate(payload({})));
    const r = getReference(store, 'https://example.com/freshness');
    expect(r!.published_at).toBeNull();
    expect(typeof r!.fetched_at).toBe('string');
  });

  it('rejects invalid ISO date for publishedAt via JSON schema', () => {
    expect(() => parseAndValidate(payload({ publishedAt: 'not-a-date' }))).toThrow(
      RefmeshValidationError,
    );
  });
});
