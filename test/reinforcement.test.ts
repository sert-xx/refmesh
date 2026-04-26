import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

describe('search reinforcement (PBI-11)', () => {
  let tempDir: string;
  let stores: RefmeshHybridStores;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'refmesh-reinf-'));
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

  it('increments accessCount for matched concepts', async () => {
    await executeRegister(
      stores,
      parseAndValidate(payload('https://example.com/r', [{ id: 'Foo', description: 'a thing' }])),
    );
    const before = await executeSearch(stores, 'a thing', {
      depth: 0,
      limit: 5,
      threshold: 0,
      format: 'json',
    });
    const accessBefore = before.matchedConcepts.find((c) => c.id === 'Foo')?.accessCount ?? -1;
    expect(accessBefore).toBe(0);

    const after = await executeSearch(stores, 'a thing', {
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
      stores,
      parseAndValidate(
        payload('https://example.com/r2', [
          { id: 'Hot', description: 'identical phrase here' },
          { id: 'Cold', description: 'identical phrase here' },
        ]),
      ),
    );
    // Hot を 5 回ヒットさせて accessCount を上げる
    for (let i = 0; i < 5; i += 1) {
      await executeSearch(stores, 'identical phrase here', {
        depth: 0,
        limit: 1,
        threshold: 0,
        format: 'json',
      });
    }

    const result = await executeSearch(stores, 'identical phrase here', {
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
      executeSearch(stores, 'q', {
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
      executeSearch(stores, 'q', {
        depth: 0,
        limit: 5,
        reinforcementWeight: -0.1,
        format: 'json',
      }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
    await expect(
      executeSearch(stores, 'q', {
        depth: 0,
        limit: 5,
        reinforcementWeight: 1.5,
        format: 'json',
      }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
  });
});
