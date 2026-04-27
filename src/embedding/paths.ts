import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_MODEL_DIRNAME = 'models';
export const REFMESH_HOME_DIRNAME = '.refmesh';

// Resolve the directory used as the @xenova/transformers FS cache. We deliberately
// keep this under ~/.refmesh/ so the model cache lives next to refmesh.db and is
// owned by refmesh rather than by the upstream package's default (which is
// node_modules-relative and breaks in sandboxed agent runners that cannot write
// into the install prefix).
export function resolveModelDir(): string {
  const fromEnv = process.env.REFMESH_MODEL_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return join(homedir(), REFMESH_HOME_DIRNAME, DEFAULT_MODEL_DIRNAME);
}
