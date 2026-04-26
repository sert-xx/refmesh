import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeRegister, parseAndValidate } from '../src/commands/register.js';
import { executeSearch } from '../src/commands/search.js';
import { type RefmeshHybridStores, openHybridStores } from '../src/db/connection.js';
import { RefmeshValidationError } from '../src/util/errors.js';

function payload(
  refUrl: string,
  publishedAt: string | undefined,
  concepts: { id: string; description: string }[],
  rels: { source: string; target: string; type: string; reason: string }[] = [],
) {
  const ref: Record<string, string> = { url: refUrl, title: `doc ${refUrl}` };
  if (publishedAt) ref.publishedAt = publishedAt;
  return JSON.stringify({ reference: ref, concepts, relationships: rels });
}

describe('search freshness scoring (PBI-9)', () => {
  let tempDir: string;
  let stores: RefmeshHybridStores;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'refmesh-fresh-search-'));
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

  it('default behaviour (freshness-weight=0) preserves cosine ranking', async () => {
    await executeRegister(
      stores,
      parseAndValidate(
        payload('https://example.com/old', '2020-01-01T00:00:00Z', [
          { id: 'OldHook', description: 'React state hook for function components' },
        ]),
      ),
    );
    await executeRegister(
      stores,
      parseAndValidate(
        payload('https://example.com/new', '2026-04-01T00:00:00Z', [
          { id: 'NewHook', description: 'React state hook for function components new' },
        ]),
      ),
    );

    const result = await executeSearch(stores, 'React state hook', {
      depth: 0,
      limit: 5,
      threshold: 0,
      freshnessWeight: 0,
      format: 'json',
    });
    expect(result.matchedConcepts.length).toBeGreaterThan(0);
    for (let i = 1; i < result.matchedConcepts.length; i += 1) {
      expect(result.matchedConcepts[i - 1]!.finalScore!).toBeGreaterThanOrEqual(
        result.matchedConcepts[i]!.finalScore!,
      );
    }
  });

  it('with freshness-weight=1 the newer concept is ranked first', async () => {
    await executeRegister(
      stores,
      parseAndValidate(
        payload('https://example.com/old2', '2018-01-01T00:00:00Z', [
          { id: 'OldHook2', description: 'React state hook for functional components' },
        ]),
      ),
    );
    await executeRegister(
      stores,
      parseAndValidate(
        payload('https://example.com/new2', '2026-04-15T00:00:00Z', [
          { id: 'NewHook2', description: 'React state hook for functional components' },
        ]),
      ),
    );

    const result = await executeSearch(stores, 'React state hook', {
      depth: 0,
      limit: 5,
      threshold: 0,
      freshnessWeight: 1.0,
      halfLifeDays: 180,
      format: 'json',
    });
    expect(result.matchedConcepts[0]?.id).toBe('NewHook2');
    expect(result.matchedConcepts[0]?.freshness).toBeGreaterThan(
      result.matchedConcepts[result.matchedConcepts.length - 1]?.freshness ?? 1,
    );
  });

  it('--max-age excludes overly old concepts', async () => {
    await executeRegister(
      stores,
      parseAndValidate(
        payload('https://example.com/ancient', '2010-01-01T00:00:00Z', [
          { id: 'AncientThing', description: 'an ancient artifact' },
        ]),
      ),
    );
    const result = await executeSearch(stores, 'ancient artifact', {
      depth: 0,
      limit: 5,
      threshold: 0,
      maxAgeDays: 30,
      format: 'json',
    });
    expect(result.matchedConcepts.find((c) => c.id === 'AncientThing')).toBeUndefined();
  });

  it('--demote-deprecated 0 excludes concepts targeted by DEPRECATES', async () => {
    await executeRegister(
      stores,
      parseAndValidate(
        payload('https://example.com/dep', undefined, [
          { id: 'OldApi', description: 'legacy api documentation' },
          { id: 'NewApi', description: 'modern api documentation' },
        ]),
      ),
    );
    await executeRegister(
      stores,
      parseAndValidate(
        payload(
          'https://example.com/dep2',
          undefined,
          [
            { id: 'OldApi', description: 'legacy api documentation' },
            { id: 'NewApi', description: 'modern api documentation' },
          ],
          [{ source: 'NewApi', target: 'OldApi', type: 'DEPRECATES', reason: 'replaced by new' }],
        ),
      ),
    );

    const result = await executeSearch(stores, 'api documentation', {
      depth: 0,
      limit: 5,
      threshold: 0,
      demoteDeprecated: 0,
      format: 'json',
    });
    expect(result.matchedConcepts.find((c) => c.id === 'OldApi')).toBeUndefined();
    expect(result.matchedConcepts.find((c) => c.id === 'NewApi')?.demoted).toBeFalsy();
  });

  it('--demote-deprecated 0.1 keeps the deprecated concept but with `demoted=true`', async () => {
    await executeRegister(
      stores,
      parseAndValidate(
        payload(
          'https://example.com/dep3',
          undefined,
          [
            { id: 'OldThing', description: 'aging implementation note' },
            { id: 'FreshThing', description: 'aging implementation note' },
          ],
          [
            {
              source: 'FreshThing',
              target: 'OldThing',
              type: 'DEPRECATES',
              reason: 'replaced',
            },
          ],
        ),
      ),
    );
    const result = await executeSearch(stores, 'aging implementation note', {
      depth: 0,
      limit: 5,
      threshold: 0,
      demoteDeprecated: 0.1,
      format: 'json',
    });
    const old = result.matchedConcepts.find((c) => c.id === 'OldThing');
    const fresh = result.matchedConcepts.find((c) => c.id === 'FreshThing');
    expect(old).toBeDefined();
    expect(old?.demoted).toBe(true);
    expect(fresh?.demoted).toBeFalsy();
    expect(old!.finalScore!).toBeLessThan(fresh!.finalScore!);
  });

  it('rejects out-of-range freshness/half-life/demote values', async () => {
    await expect(
      executeSearch(stores, 'q', { depth: 0, limit: 5, freshnessWeight: 1.5, format: 'json' }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
    await expect(
      executeSearch(stores, 'q', { depth: 0, limit: 5, halfLifeDays: 0, format: 'json' }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
    await expect(
      executeSearch(stores, 'q', { depth: 0, limit: 5, maxAgeDays: -1, format: 'json' }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
    await expect(
      executeSearch(stores, 'q', { depth: 0, limit: 5, demoteDeprecated: 2, format: 'json' }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
  });
});
