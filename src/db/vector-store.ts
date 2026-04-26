import { mkdirSync } from 'node:fs';
import * as lancedb from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Schema, Utf8 } from 'apache-arrow';
import { EMBEDDING_DIMENSION } from '../embedding/embedder.js';
import { RefmeshRuntimeError } from '../util/errors.js';
import { resolveVectorPath } from './paths.js';

export const VECTOR_TABLE_NAME = 'concepts';

export interface VectorRecord {
  id: string;
  text: string;
  vector: number[];
}

export interface VectorQueryHit {
  id: string;
  text: string;
  score: number;
}

export interface VectorQueryOptions {
  limit: number;
  threshold: number;
}

export interface VectorStore {
  readonly path: string;
  upsert(records: VectorRecord[]): Promise<void>;
  queryByVector(vector: number[], options: VectorQueryOptions): Promise<VectorQueryHit[]>;
  deleteById(id: string): Promise<void>;
  clearAll(): Promise<void>;
  countAll(): Promise<number>;
  close(): Promise<void>;
}

function buildSchema(): Schema {
  return new Schema([
    new Field('id', new Utf8(), false),
    new Field('text', new Utf8(), false),
    new Field(
      'vector',
      new FixedSizeList(EMBEDDING_DIMENSION, new Field('item', new Float32(), true)),
      false,
    ),
  ]);
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

export async function openVectorStore(pathOverride?: string): Promise<VectorStore> {
  const path = pathOverride ?? resolveVectorPath();
  mkdirSync(path, { recursive: true });

  let conn: lancedb.Connection;
  try {
    conn = await lancedb.connect(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RefmeshRuntimeError(`Failed to open vector store at ${path}: ${msg}`);
  }

  let table: lancedb.Table;
  try {
    const names = await conn.tableNames();
    if (names.includes(VECTOR_TABLE_NAME)) {
      table = await conn.openTable(VECTOR_TABLE_NAME);
    } else {
      table = await conn.createEmptyTable(VECTOR_TABLE_NAME, buildSchema(), {
        mode: 'create',
        existOk: true,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RefmeshRuntimeError(`Failed to initialize vector table: ${msg}`);
  }

  const store: VectorStore = {
    path,
    async upsert(records) {
      if (records.length === 0) return;
      for (const r of records) {
        if (r.vector.length !== EMBEDDING_DIMENSION) {
          throw new RefmeshRuntimeError(
            `Vector dimension mismatch for id=${r.id}: expected ${EMBEDDING_DIMENSION}, got ${r.vector.length}`,
          );
        }
      }
      await table
        .mergeInsert('id')
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(records as unknown as Record<string, unknown>[]);
    },
    async queryByVector(vector, options) {
      if (vector.length !== EMBEDDING_DIMENSION) {
        throw new RefmeshRuntimeError(
          `Query vector dimension mismatch: expected ${EMBEDDING_DIMENSION}, got ${vector.length}`,
        );
      }
      const total = await table.countRows();
      if (total === 0) return [];
      const limit = Math.max(1, Math.floor(options.limit));
      const results = (await table
        .query()
        .nearestTo(vector)
        .distanceType('cosine')
        .limit(limit)
        .toArray()) as Array<Record<string, unknown>>;
      const hits: VectorQueryHit[] = [];
      for (const row of results) {
        const id = String(row['id'] ?? '');
        const text = String(row['text'] ?? '');
        const distance = Number(row['_distance'] ?? row['distance'] ?? 0);
        // Cosine distance in LanceDB is 1 - cosine_similarity, range [0, 2].
        // Map to similarity in [0, 1]: similarity = 1 - distance / 2.
        const score = Math.max(0, Math.min(1, 1 - distance / 2));
        if (score >= options.threshold) {
          hits.push({ id, text, score });
        }
      }
      hits.sort((a, b) => b.score - a.score);
      return hits;
    },
    async deleteById(id) {
      await table.delete(`id = '${escapeSqlLiteral(id)}'`);
    },
    async clearAll() {
      await table.delete('true');
    },
    async countAll() {
      return await table.countRows();
    },
    async close() {
      conn.close();
    },
  };

  return store;
}
