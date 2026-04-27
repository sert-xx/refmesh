import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import kuzuDefault, * as kuzuNs from 'kuzu';
import { resolveDbPath } from './paths.js';
import { ensureSchema } from './schema.js';
import { type VectorStore, openVectorStore } from './vector-store.js';

// Normalize default export across CJS/ESM interop shims.
// biome-ignore lint/suspicious/noExplicitAny: dynamic interop
const kuzu: any = (kuzuDefault as any)?.Database ? kuzuDefault : (kuzuNs as any);

export interface KuzuQueryResult {
  getAll(): Promise<Record<string, unknown>[]>;
  close?(): void;
}

export interface KuzuConnection {
  query(stmt: string): Promise<KuzuQueryResult>;
  execute(prepared: unknown, params: Record<string, unknown>): Promise<KuzuQueryResult>;
  prepare(stmt: string): Promise<unknown>;
  close?(): void;
}

export interface RefmeshDb {
  readonly path: string;
  readonly connection: KuzuConnection;
  close(): void;
}

let cached: RefmeshDb | null = null;

export async function openDb(pathOverride?: string): Promise<RefmeshDb> {
  if (cached && !pathOverride) {
    return cached;
  }

  const dbPath = pathOverride ?? resolveDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  const database = new kuzu.Database(dbPath);
  const connection = new kuzu.Connection(database) as KuzuConnection;

  await ensureSchema(connection);

  const instance: RefmeshDb = {
    path: dbPath,
    connection,
    close() {
      connection.close?.();
      database.close?.();
      if (cached === instance) {
        cached = null;
      }
    },
  };

  if (!pathOverride) {
    cached = instance;
  }
  return instance;
}

export interface RefmeshHybridStores {
  readonly graph: RefmeshDb;
  readonly vector: VectorStore;
  close(): Promise<void>;
}

export interface HybridStoreOptions {
  graphPath?: string;
  vectorPath?: string;
}

export async function openHybridStores(
  options: HybridStoreOptions = {},
): Promise<RefmeshHybridStores> {
  const graph = await openDb(options.graphPath);
  let vector: VectorStore;
  try {
    vector = await openVectorStore(options.vectorPath);
  } catch (err) {
    graph.close();
    throw err;
  }
  return {
    graph,
    vector,
    async close() {
      try {
        await vector.close();
      } finally {
        graph.close();
      }
    },
  };
}

// Run `fn` against an already-open stores handle and guarantee `close()`
// runs before returning, regardless of whether `fn` resolved or threw. Kùzu
// 0.6 uses file-level exclusive locks; relying on Node's natural exit to
// release them is fragile (process.exit skips finalizers, and V8 teardown can
// run the native destructor twice and segfault — see src/commands/console.ts).
// Exported separately from `withHybridStores` to allow injecting a fake
// stores object in tests without touching real DB resources.
export async function runAndClose<T>(
  stores: RefmeshHybridStores,
  fn: (stores: RefmeshHybridStores) => Promise<T>,
): Promise<T> {
  try {
    return await fn(stores);
  } finally {
    try {
      await stores.close();
    } catch {
      // best effort — close failures must not mask the original outcome
    }
  }
}

export async function withHybridStores<T>(
  fn: (stores: RefmeshHybridStores) => Promise<T>,
  options: HybridStoreOptions = {},
): Promise<T> {
  return runAndClose(await openHybridStores(options), fn);
}
