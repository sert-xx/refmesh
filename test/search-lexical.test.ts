import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeRegister, parseAndValidate } from '../src/commands/register.js';
import { executeSearch, executeSearchWithTrace, tokenize } from '../src/commands/search.js';
import { type RefmeshHybridStores, openHybridStores } from '../src/db/connection.js';
import { RefmeshValidationError } from '../src/util/errors.js';

function payload(refUrl: string, concepts: { id: string; description: string }[]) {
  return JSON.stringify({
    reference: { url: refUrl, title: `doc ${refUrl}` },
    concepts,
    relationships: [],
  });
}

describe('tokenize (PBI-17)', () => {
  it('splits on whitespace and id-style separators', () => {
    expect(new Set(tokenize('Google Kubernetes Engine'))).toEqual(
      new Set(['google', 'kubernetes', 'engine']),
    );
    expect(new Set(tokenize('kube_proxy-config.yaml'))).toEqual(
      new Set(['kube', 'proxy', 'config', 'yaml']),
    );
    expect(new Set(tokenize('a/b:c'))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('breaks on camelCase / PascalCase boundaries', () => {
    expect(new Set(tokenize('GoogleKubernetes'))).toEqual(new Set(['google', 'kubernetes']));
    expect(new Set(tokenize('useState'))).toEqual(new Set(['use', 'state']));
    expect(new Set(tokenize('HTTPServer'))).toEqual(new Set(['http', 'server']));
  });

  it('lower-cases every token', () => {
    expect(tokenize('FOO BAR')).toEqual(['foo', 'bar']);
  });

  it('returns an empty array on empty input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('search lexical boost integration (PBI-17)', () => {
  let tempDir: string;
  let stores: RefmeshHybridStores;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'refmesh-lex-'));
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

  // Case A from PBI-17: the failing real-world example.
  it('keeps "Google Block Storage" out of the top results when searching "Kubernetes"', async () => {
    await executeRegister(
      stores,
      parseAndValidate(
        payload('https://example.com/gcp', [
          {
            id: 'Google Kubernetes Engine',
            description: 'managed Kubernetes service on Google Cloud',
          },
          {
            id: 'Google Kubernetes Engine Network',
            description: 'networking layer for managed Kubernetes service on Google Cloud',
          },
          {
            id: 'Google Block Storage',
            description: 'persistent block storage for virtual machines on Google Cloud',
          },
        ]),
      ),
    );

    const result = await executeSearch(stores, 'Kubernetes', {
      depth: 0,
      limit: 3,
      threshold: 0,
      format: 'json',
    });
    const top2 = result.matchedConcepts.slice(0, 2).map((c) => c.id);
    expect(top2).not.toContain('Google Block Storage');
    expect(top2).toContain('Google Kubernetes Engine');
    // Both Kubernetes-bearing concepts should be among the top 2 hits.
    expect(top2).toContain('Google Kubernetes Engine Network');
  });

  // Case B: lexicalWeight=0 must restore the pre-PBI behaviour byte-for-byte
  // for the lexical contribution. We verify this by checking that
  // finalScore == cosineWeight*cosine for a freshness/reinforcement-free
  // search (with lexicalWeight=0 forcing cosineWeight back to 1).
  it('lexicalWeight=0 disables the lexical contribution to finalScore', async () => {
    await executeRegister(
      stores,
      parseAndValidate(
        payload('https://example.com/zero', [
          { id: 'Foo', description: 'totally unrelated subject' },
          { id: 'Bar', description: 'another unrelated subject' },
        ]),
      ),
    );

    const result = await executeSearch(stores, 'subject', {
      depth: 0,
      limit: 5,
      threshold: 0,
      lexicalWeight: 0,
      format: 'json',
    });
    for (const hit of result.matchedConcepts) {
      // cosineWeight is 1, freshness/reinforcement weights default to 0.
      // So finalScore must equal cosine (a.k.a. score) within float tolerance.
      expect(Math.abs((hit.finalScore ?? 0) - (hit.score ?? 0))).toBeLessThan(1e-9);
    }
  });

  // Case C: a concept that shares no token with the query gets lexical=0.
  it('lexical score is zero when no query token appears in id/description/details', async () => {
    await executeRegister(
      stores,
      parseAndValidate(
        payload('https://example.com/disjoint', [
          { id: 'Foo', description: 'volcano basalt magma lithography' },
        ]),
      ),
    );
    const { result } = await executeSearchWithTrace(stores, 'kubernetes', {
      depth: 0,
      limit: 5,
      threshold: 0,
      format: 'json',
    });
    const foo = result.matchedConcepts.find((c) => c.id === 'Foo');
    expect(foo?.lexical ?? 0).toBe(0);
  });

  // Case D: lexicalWeight=1 zeroes finalScore for any concept missing the
  // query token entirely (cosineWeight collapses to 0 and lexical itself is 0).
  it('lexicalWeight=1 makes finalScore=0 for concepts without any token overlap', async () => {
    await executeRegister(
      stores,
      parseAndValidate(
        payload('https://example.com/lex1', [
          { id: 'Hit', description: 'kubernetes pod scheduler' },
          { id: 'Miss', description: 'volcano basalt magma' },
        ]),
      ),
    );
    const result = await executeSearch(stores, 'kubernetes', {
      depth: 0,
      limit: 5,
      threshold: 0,
      lexicalWeight: 1,
      format: 'json',
    });
    const miss = result.matchedConcepts.find((c) => c.id === 'Miss');
    if (miss) {
      expect(miss.finalScore).toBeCloseTo(0, 9);
    }
    const hit = result.matchedConcepts.find((c) => c.id === 'Hit');
    expect(hit).toBeDefined();
    expect((hit?.finalScore ?? 0) > 0).toBe(true);
  });

  it('rejects --lexical-weight outside [0, 1]', async () => {
    await expect(
      executeSearch(stores, 'q', {
        depth: 0,
        limit: 5,
        lexicalWeight: -0.1,
        format: 'json',
      }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
    await expect(
      executeSearch(stores, 'q', {
        depth: 0,
        limit: 5,
        lexicalWeight: 1.5,
        format: 'json',
      }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
  });

  it('trace surfaces queryTokens and per-candidate lexical', async () => {
    await executeRegister(
      stores,
      parseAndValidate(
        payload('https://example.com/trace', [
          { id: 'Google Kubernetes Engine', description: 'managed kubernetes service' },
          { id: 'Google Block Storage', description: 'persistent block storage' },
        ]),
      ),
    );
    const { trace } = await executeSearchWithTrace(stores, 'Kubernetes', {
      depth: 0,
      limit: 5,
      threshold: 0,
      format: 'json',
    });
    expect(trace.queryTokens).toContain('kubernetes');
    const gke = trace.candidates.find((c) => c.id === 'Google Kubernetes Engine');
    const gbs = trace.candidates.find((c) => c.id === 'Google Block Storage');
    expect(gke?.lexical).toBeGreaterThan(0);
    expect(gbs?.lexical ?? 0).toBe(0);
  });
});
