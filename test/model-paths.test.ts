import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveModelDir } from '../src/embedding/paths.js';

describe('resolveModelDir', () => {
  const original = process.env.REFMESH_MODEL_DIR;

  beforeEach(() => {
    delete process.env.REFMESH_MODEL_DIR;
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env.REFMESH_MODEL_DIR;
    } else {
      process.env.REFMESH_MODEL_DIR = original;
    }
  });

  it('defaults to ~/.refmesh/models/ so model cache lives next to refmesh.db', () => {
    expect(resolveModelDir()).toBe(join(homedir(), '.refmesh', 'models'));
  });

  it('honors REFMESH_MODEL_DIR override (used by sandboxed agent runners with a writable temp dir)', () => {
    process.env.REFMESH_MODEL_DIR = '/tmp/refmesh-models-test';
    expect(resolveModelDir()).toBe('/tmp/refmesh-models-test');
  });

  it('treats whitespace-only override as unset', () => {
    process.env.REFMESH_MODEL_DIR = '   ';
    expect(resolveModelDir()).toBe(join(homedir(), '.refmesh', 'models'));
  });
});
