import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

describe('search reinforcement (PBI-11)', () => {
  let tempDir: string;
  let store: RefmeshStore;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'refmesh-reinf-'));
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

  it('increments accessCount for matched concepts', async () => {
    await executeRegister(
      store,
      parseAndValidate(payload('https://example.com/r', [{ id: 'Foo', description: 'a thing' }])),
    );
    const before = await executeSearch(store, 'a thing', {
      depth: 0,
      limit: 5,
      threshold: 0,
      format: 'json',
    });
    const accessBefore = before.matchedConcepts.find((c) => c.id === 'Foo')?.accessCount ?? -1;
    expect(accessBefore).toBe(0);

    const after = await executeSearch(store, 'a thing', {
      depth: 0,
      limit: 5,
      threshold: 0,
      format: 'json',
    });
    const accessAfter = after.matchedConcepts.find((c) => c.id === 'Foo')?.accessCount ?? -1;
    expect(accessAfter).toBe(1);
  });

  it('with --reinforcement-weight=1, the concept with higher accessCount ranks first', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload('https://example.com/r2', [
          { id: 'Hot', description: 'identical phrase here' },
          { id: 'Cold', description: 'identical phrase here' },
        ]),
      ),
    );
    // Hot を 5 回ヒットさせて accessCount を上げる
    for (let i = 0; i < 5; i += 1) {
      await executeSearch(store, 'identical phrase here', {
        depth: 0,
        limit: 1,
        threshold: 0,
        format: 'json',
      });
    }

    const result = await executeSearch(store, 'identical phrase here', {
      depth: 0,
      limit: 5,
      threshold: 0,
      reinforcementWeight: 1.0,
      format: 'json',
    });
    expect(result.matchedConcepts[0]?.id).toBe('Hot');
    expect(result.matchedConcepts[0]?.reinforcement).toBeGreaterThan(0);
  });

  it('rejects freshness + reinforcement > 1', async () => {
    await expect(
      executeSearch(store, 'q', {
        depth: 0,
        limit: 5,
        freshnessWeight: 0.6,
        reinforcementWeight: 0.5,
        format: 'json',
      }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
  });

  it('rejects out-of-range reinforcement weight', async () => {
    await expect(
      executeSearch(store, 'q', {
        depth: 0,
        limit: 5,
        reinforcementWeight: -0.1,
        format: 'json',
      }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
    await expect(
      executeSearch(store, 'q', {
        depth: 0,
        limit: 5,
        reinforcementWeight: 1.5,
        format: 'json',
      }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
  });
});
