import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeArchive, executePrune, executeUnarchive } from '../src/commands/archive.js';
import { executeRegister, parseAndValidate } from '../src/commands/register.js';
import { executeSearch } from '../src/commands/search.js';
import { type RefmeshHybridStores, openHybridStores } from '../src/db/connection.js';
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
  let stores: RefmeshHybridStores;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'refmesh-arch-'));
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

  it('archive hides a concept from default search; unarchive restores it', async () => {
    await executeRegister(
      stores,
      parseAndValidate(payload('https://example.com/a', [{ id: 'Foo', description: 'a thing' }])),
    );

    await executeArchive(stores, 'Foo', { reason: 'outdated' });

    const hidden = await executeSearch(stores, 'a thing', {
      depth: 0,
      limit: 5,
      threshold: 0,
      format: 'json',
    });
    expect(hidden.matchedConcepts.find((c) => c.id === 'Foo')).toBeUndefined();

    const visible = await executeSearch(stores, 'a thing', {
      depth: 0,
      limit: 5,
      threshold: 0,
      includeArchived: true,
      format: 'json',
    });
    expect(visible.matchedConcepts.find((c) => c.id === 'Foo')).toBeDefined();

    await executeUnarchive(stores, 'Foo');
    const restored = await executeSearch(stores, 'a thing', {
      depth: 0,
      limit: 5,
      threshold: 0,
      format: 'json',
    });
    expect(restored.matchedConcepts.find((c) => c.id === 'Foo')).toBeDefined();
  });

  it('archive on missing id throws RefmeshValidationError', async () => {
    await expect(executeArchive(stores, 'NoSuchId')).rejects.toBeInstanceOf(RefmeshValidationError);
    await expect(executeUnarchive(stores, 'NoSuchId')).rejects.toBeInstanceOf(
      RefmeshValidationError,
    );
  });

  it('prune dry-run reports candidates without deleting; --apply removes them from both stores', async () => {
    // Register one concept and rewind its lastSeenAt to long ago.
    await executeRegister(
      stores,
      parseAndValidate(payload('https://example.com/p', [{ id: 'StaleX', description: 'old' }])),
    );
    const old = new Date('2020-01-01T00:00:00Z');
    await stores.graph.connection
      .prepare('MATCH (c:Concept) WHERE c.id = $id SET c.lastSeenAt = $old')
      .then((p) => stores.graph.connection.execute(p, { id: 'StaleX', old }));

    const dry = await executePrune(stores, {
      olderThanDays: 30,
      maxTouches: 1,
      includeArchived: false,
      apply: false,
    });
    expect(dry.applied).toBe(false);
    expect(dry.candidates.map((c) => c.id)).toContain('StaleX');
    expect(dry.deleted).toBe(0);

    const before = await stores.vector.countAll();
    expect(before).toBeGreaterThanOrEqual(1);

    const applied = await executePrune(stores, {
      olderThanDays: 30,
      maxTouches: 1,
      includeArchived: false,
      apply: true,
    });
    expect(applied.applied).toBe(true);
    expect(applied.deleted).toBeGreaterThanOrEqual(1);
    expect(applied.vectorsDeleted).toBeGreaterThanOrEqual(1);
    expect(await stores.vector.countAll()).toBeLessThan(before);

    const stillThere = await stores.graph.connection
      .prepare('MATCH (c:Concept) WHERE c.id = $id RETURN c.id AS id')
      .then(async (p) => (await stores.graph.connection.execute(p, { id: 'StaleX' })).getAll());
    expect(stillThere).toHaveLength(0);
  });

  it('prune does not touch archived concepts unless --include-archived', async () => {
    await executeRegister(
      stores,
      parseAndValidate(
        payload('https://example.com/p2', [{ id: 'ArchivedY', description: 'archived old' }]),
      ),
    );
    const old = new Date('2020-01-01T00:00:00Z');
    await stores.graph.connection
      .prepare('MATCH (c:Concept) WHERE c.id = $id SET c.lastSeenAt = $old')
      .then((p) => stores.graph.connection.execute(p, { id: 'ArchivedY', old }));
    await executeArchive(stores, 'ArchivedY');

    const skip = await executePrune(stores, {
      olderThanDays: 30,
      maxTouches: 1,
      includeArchived: false,
      apply: false,
    });
    expect(skip.candidates.map((c) => c.id)).not.toContain('ArchivedY');

    const include = await executePrune(stores, {
      olderThanDays: 30,
      maxTouches: 1,
      includeArchived: true,
      apply: false,
    });
    expect(include.candidates.map((c) => c.id)).toContain('ArchivedY');
  });

  it('prune validates option ranges', async () => {
    await expect(
      executePrune(stores, {
        olderThanDays: -1,
        maxTouches: 1,
        includeArchived: false,
        apply: false,
      }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
    await expect(
      executePrune(stores, {
        olderThanDays: 30,
        maxTouches: -1,
        includeArchived: false,
        apply: false,
      }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
  });
});
