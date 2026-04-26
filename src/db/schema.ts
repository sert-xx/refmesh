import { ALL_EDGE_TYPE_NAMES, INTERNAL_DESCRIBES_EDGE } from '../schema/edge-types.js';
import type { KuzuConnection } from './connection.js';

const NODE_TABLE_STATEMENTS: readonly string[] = [
  `CREATE NODE TABLE IF NOT EXISTS Reference (
    url STRING,
    title STRING,
    firstSeenAt TIMESTAMP,
    lastSeenAt TIMESTAMP,
    publishedAt TIMESTAMP,
    fetchedAt TIMESTAMP,
    PRIMARY KEY (url)
  )`,
  `CREATE NODE TABLE IF NOT EXISTS Concept (
    id STRING,
    description STRING,
    details STRING,
    firstSeenAt TIMESTAMP,
    lastSeenAt TIMESTAMP,
    touchCount INT64 DEFAULT 0,
    accessCount INT64 DEFAULT 0,
    archivedAt TIMESTAMP,
    archiveReason STRING DEFAULT '',
    PRIMARY KEY (id)
  )`,
];

interface ColumnSpec {
  table: string;
  column: string;
  type: string;
  defaultClause?: string;
}

const COLUMN_MIGRATIONS: readonly ColumnSpec[] = [
  { table: 'Reference', column: 'firstSeenAt', type: 'TIMESTAMP' },
  { table: 'Reference', column: 'lastSeenAt', type: 'TIMESTAMP' },
  { table: 'Reference', column: 'publishedAt', type: 'TIMESTAMP' },
  { table: 'Reference', column: 'fetchedAt', type: 'TIMESTAMP' },
  { table: 'Concept', column: 'firstSeenAt', type: 'TIMESTAMP' },
  { table: 'Concept', column: 'lastSeenAt', type: 'TIMESTAMP' },
  { table: 'Concept', column: 'touchCount', type: 'INT64', defaultClause: 'DEFAULT 0' },
  { table: 'Concept', column: 'accessCount', type: 'INT64', defaultClause: 'DEFAULT 0' },
  { table: 'Concept', column: 'archivedAt', type: 'TIMESTAMP' },
  { table: 'Concept', column: 'archiveReason', type: 'STRING', defaultClause: "DEFAULT ''" },
];

function conceptToConceptEdgeDDL(type: string): string {
  return `CREATE REL TABLE IF NOT EXISTS ${type} (FROM Concept TO Concept, reason STRING)`;
}

function describesEdgeDDL(): string {
  return `CREATE REL TABLE IF NOT EXISTS ${INTERNAL_DESCRIBES_EDGE} (FROM Reference TO Concept)`;
}

async function tryAddColumn(conn: KuzuConnection, spec: ColumnSpec): Promise<void> {
  const ddl = `ALTER TABLE ${spec.table} ADD ${spec.column} ${spec.type}${
    spec.defaultClause ? ` ${spec.defaultClause}` : ''
  }`;
  try {
    await conn.query(ddl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already has property/i.test(msg)) {
      throw err;
    }
  }
}

export async function ensureSchema(conn: KuzuConnection): Promise<void> {
  for (const stmt of NODE_TABLE_STATEMENTS) {
    await conn.query(stmt);
  }

  for (const spec of COLUMN_MIGRATIONS) {
    await tryAddColumn(conn, spec);
  }

  for (const edgeType of ALL_EDGE_TYPE_NAMES) {
    if (edgeType === INTERNAL_DESCRIBES_EDGE) {
      await conn.query(describesEdgeDDL());
    } else {
      await conn.query(conceptToConceptEdgeDDL(edgeType));
    }
  }
}
