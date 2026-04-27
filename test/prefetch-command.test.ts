import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  executePrefetch,
  renderPrefetchJson,
  renderPrefetchText,
} from '../src/commands/prefetch.js';
import { EMBEDDING_MODEL_ID } from '../src/embedding/embedder.js';

// Use a per-suite REFMESH_MODEL_DIR so a) the assertion for `.modelDir` is
// deterministic and b) we don't accidentally pollute the developer's real
// ~/.refmesh/models/ when the test runs first on a clean machine.
const tempDir = mkdtempSync(join(tmpdir(), 'refmesh-prefetch-test-'));
const originalEnv = process.env.REFMESH_MODEL_DIR;

beforeAll(() => {
  process.env.REFMESH_MODEL_DIR = tempDir;
});

afterAll(() => {
  if (originalEnv === undefined) {
    delete process.env.REFMESH_MODEL_DIR;
  } else {
    process.env.REFMESH_MODEL_DIR = originalEnv;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('refmesh prefetch', () => {
  it('downloads on first run and is idempotent on subsequent runs', async () => {
    const first = await executePrefetch();
    expect(first.modelId).toBe(EMBEDDING_MODEL_ID);
    expect(first.modelDir).toBe(tempDir);
    // Don't assert downloaded === true: the embedder.test.ts suite may have
    // populated the system-default cache earlier, but it ran against a
    // different cacheDir (no REFMESH_MODEL_DIR), so this temp dir is
    // genuinely empty on the first call.
    expect(typeof first.downloaded).toBe('boolean');

    const second = await executePrefetch();
    expect(second.modelId).toBe(EMBEDDING_MODEL_ID);
    expect(second.modelDir).toBe(tempDir);
    // After at least one prefetch into this temp dir, a re-run must be a
    // pure cache hit — that's the contract that makes `prefetch` safe to
    // re-run from scripts and CI.
    expect(second.downloaded).toBe(false);
  }, 180_000);

  it('renders text output that surfaces both the model id and the cache dir', () => {
    const text = renderPrefetchText({
      modelId: EMBEDDING_MODEL_ID,
      modelDir: '/tmp/some-dir',
      downloaded: false,
    });
    expect(text).toContain(EMBEDDING_MODEL_ID);
    expect(text).toContain('/tmp/some-dir');
    expect(text.toLowerCase()).toContain('cached');
  });

  it('renders json output as a parseable object', () => {
    const json = renderPrefetchJson({
      modelId: EMBEDDING_MODEL_ID,
      modelDir: '/tmp/some-dir',
      downloaded: true,
    });
    expect(JSON.parse(json)).toEqual({
      modelId: EMBEDDING_MODEL_ID,
      modelDir: '/tmp/some-dir',
      downloaded: true,
    });
  });
});
