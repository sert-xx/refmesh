import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_DB_DIRNAME = '.refmesh';
export const DEFAULT_DB_FILENAME = 'refmesh.db';

export function resolveDbPath(): string {
  const fromEnv = process.env.REFMESH_DB_PATH?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return join(homedir(), DEFAULT_DB_DIRNAME, DEFAULT_DB_FILENAME);
}
