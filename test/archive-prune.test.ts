import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeArchive, executePrune, executeUnarchive } from '../src/commands/archive.js';
import { executeRegister, parseAndValidate } from '../src/commands/register.js';
import { executeSearch } from '../src/commands/search.js';
import { type RefmeshStore, openStore } from '../src/db/store.js';
import { RefmeshValidationError } from '../src/util/errors.js';

function payload(refUrl: string, concepts: { id: string; description: string }[]) {
  return JSON.stringify({
    reference: { url: refUrl, title: `doc ${refUrl}` },
    concepts,
    relationships: [],
  });
}

describe('archive / unarchive / prune (PBI-10)', () => {
  let tempDir: string;
  let store: RefmeshStore;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'refmesh-arch-'));
    store = openStore({ dbPath: join(tempDir, 'refmesh.db') });
  });

  afterAll(async () => {
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

  it('archive hides a concept from default search; unarchive restores it', async () => {
    await executeRegister(
      store,
      parseAndValidate(payload('https://example.com/a', [{ id: 'Foo', description: 'a thing' }])),
    );

    await executeArchive(store, 'Foo', { reason: 'outdated' });

    const hidden = await executeSearch(store, 'a thing', {
      depth: 0,
      limit: 5,
      threshold: 0,
      format: 'json',
    });
    expect(hidden.matchedConcepts.find((c) => c.id === 'Foo')).toBeUndefined();

    const visible = await executeSearch(store, 'a thing', {
      depth: 0,
      limit: 5,
      threshold: 0,
      includeArchived: true,
      format: 'json',
    });
    expect(visible.matchedConcepts.find((c) => c.id === 'Foo')).toBeDefined();

    await executeUnarchive(store, 'Foo');
    const restored = await executeSearch(store, 'a thing', {
      depth: 0,
      limit: 5,
      threshold: 0,
      format: 'json',
    });
    expect(restored.matchedConcepts.find((c) => c.id === 'Foo')).toBeDefined();
  });

  it('archive on missing id throws RefmeshValidationError', async () => {
    await expect(executeArchive(store, 'NoSuchId')).rejects.toBeInstanceOf(RefmeshValidationError);
    await expect(executeUnarchive(store, 'NoSuchId')).rejects.toBeInstanceOf(
      RefmeshValidationError,
    );
  });

  it('prune dry-run reports candidates without deleting; --apply removes them from both store', async () => {
    // Register one concept and rewind its lastSeenAt to long ago.
    await executeRegister(
      store,
      parseAndValidate(payload('https://example.com/p', [{ id: 'StaleX', description: 'old' }])),
    );
    const old = new Date('2020-01-01T00:00:00Z');
    store.db
      .prepare<[string, string]>('UPDATE concepts SET last_seen_at = ? WHERE id = ?')
      .run(old.toISOString(), 'StaleX');

    const dry = await executePrune(store, {
      olderThanDays: 30,
      maxTouches: 1,
      includeArchived: false,
      apply: false,
    });
    expect(dry.applied).toBe(false);
    expect(dry.candidates.map((c) => c.id)).toContain('StaleX');
    expect(dry.deleted).toBe(0);

    const before = await store.vectors.countAll();
    expect(before).toBeGreaterThanOrEqual(1);

    const applied = await executePrune(store, {
      olderThanDays: 30,
      maxTouches: 1,
      includeArchived: false,
      apply: true,
    });
    expect(applied.applied).toBe(true);
    expect(applied.deleted).toBeGreaterThanOrEqual(1);
    expect(applied.vectorsDeleted).toBeGreaterThanOrEqual(1);
    expect(await store.vectors.countAll()).toBeLessThan(before);

    const stillThere = store.db
      .prepare<[string]>('SELECT id FROM concepts WHERE id = ?')
      .all('StaleX');
    expect(stillThere).toHaveLength(0);
  });

  it('prune does not touch archived concepts unless --include-archived', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload('https://example.com/p2', [{ id: 'ArchivedY', description: 'archived old' }]),
      ),
    );
    const old = new Date('2020-01-01T00:00:00Z');
    store.db
      .prepare<[string, string]>('UPDATE concepts SET last_seen_at = ? WHERE id = ?')
      .run(old.toISOString(), 'ArchivedY');
    await executeArchive(store, 'ArchivedY');

    const skip = await executePrune(store, {
      olderThanDays: 30,
      maxTouches: 1,
      includeArchived: false,
      apply: false,
    });
    expect(skip.candidates.map((c) => c.id)).not.toContain('ArchivedY');

    const include = await executePrune(store, {
      olderThanDays: 30,
      maxTouches: 1,
      includeArchived: true,
      apply: false,
    });
    expect(include.candidates.map((c) => c.id)).toContain('ArchivedY');
  });

  it('prune validates option ranges', async () => {
    await expect(
      executePrune(store, {
        olderThanDays: -1,
        maxTouches: 1,
        includeArchived: false,
        apply: false,
      }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
    await expect(
      executePrune(store, {
        olderThanDays: 30,
        maxTouches: -1,
        includeArchived: false,
        apply: false,
      }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
  });
});
