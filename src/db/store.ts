import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { RefmeshRuntimeError } from '../util/errors.js';
import { applyMigrations } from './migrations.js';
import { resolveDbPath } from './paths.js';
import { StatementCache } from './statement-cache.js';
import { VectorIndex } from './vector-index.js';

export interface RefmeshStore {
  readonly path: string;
  readonly db: Database.Database;
  readonly statements: StatementCache;
  readonly vectors: VectorIndex;
  // Wraps better-sqlite3's `transaction()` API. Use for register / prune
  // and any other operation that must be atomic across multiple tables.
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface OpenStoreOptions {
  dbPath?: string;
}

export function openStore(options: OpenStoreOptions = {}): RefmeshStore {
  const path = options.dbPath ?? resolveDbPath();
  mkdirSync(dirname(path), { recursive: true });

  let db: Database.Database;
  try {
    db = new Database(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RefmeshRuntimeError(`Failed to open SQLite database at ${path}: ${msg}`);
  }

  // PRAGMA tuning runs before any DDL so migrations themselves benefit.
  // - WAL: concurrent readers + single writer, dramatically faster than the
  //   default rollback journal for our register/search mixed load.
  // - foreign_keys: required for the FK CASCADE chains on concepts → edges
  //   / describes / vectors. SQLite ships with this OFF for legacy reasons.
  // - synchronous=NORMAL: still fsync's at WAL checkpoint boundaries, but
  //   skips per-commit fsync. Crash safety is preserved (no torn pages); we
  //   only risk losing the last few committed transactions on a hard kill,
  //   which is acceptable for an idempotent register pipeline.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  applyMigrations(db);

  const statements = new StatementCache(db);
  const vectors = new VectorIndex(db);
  vectors.loadAll();

  let closed = false;
  const store: RefmeshStore = {
    path,
    db,
    statements,
    vectors,
    transaction<T>(fn: () => T): T {
      const tx = db.transaction(fn);
      return tx.immediate();
    },
    close() {
      if (closed) return;
      closed = true;
      statements.clear();
      try {
        db.close();
      } catch {
        // best-effort
      }
    },
  };
  return store;
}

export async function runAndClose<T>(
  store: RefmeshStore,
  fn: (store: RefmeshStore) => Promise<T>,
): Promise<T> {
  try {
    return await fn(store);
  } finally {
    try {
      // Real SQLite close() is sync, but tests pass spies that return a
      // Promise. Wrapping in Promise.resolve lets us await both shapes
      // without forcing the production close to become async.
      await Promise.resolve(store.close());
    } catch {
      // close failures must not mask the original outcome
    }
  }
}

export async function withStore<T>(
  fn: (store: RefmeshStore) => Promise<T>,
  options: OpenStoreOptions = {},
): Promise<T> {
  return runAndClose(openStore(options), fn);
}
