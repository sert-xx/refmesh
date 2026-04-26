import { readFileSync } from 'node:fs';
import AjvModule, { type ErrorObject } from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { KuzuConnection, RefmeshHybridStores } from '../db/connection.js';
import type { VectorRecord, VectorStore } from '../db/vector-store.js';
import { composeConceptText, embedBatch } from '../embedding/embedder.js';
import { INTERNAL_DESCRIBES_EDGE, isPublicEdgeType } from '../schema/edge-types.js';
import { REGISTER_JSON_SCHEMA, type RegisterInput } from '../schema/register-schema.js';
import { RefmeshValidationError } from '../util/errors.js';

export const SAME_AS_SIMILARITY_THRESHOLD = 0.95;

// Ajv/ajv-formats are CommonJS; default export interop needs an explicit shim under NodeNext.
// biome-ignore lint/suspicious/noExplicitAny: ESM/CJS interop shim
const Ajv: any = (AjvModule as any).default ?? AjvModule;
// biome-ignore lint/suspicious/noExplicitAny: ESM/CJS interop shim
const addFormats: any = (addFormatsModule as any).default ?? addFormatsModule;

export interface RegisterOptions {
  file?: string;
}

export interface SimilarConceptWarning {
  newId: string;
  existingId: string;
  score: number;
}

export interface RegisterSummary {
  reference: { url: string; title: string; created: boolean };
  conceptsUpserted: number;
  describesEdges: number;
  relationshipsByType: Record<string, number>;
  vectorsUpserted: number;
  similarWarnings: SimilarConceptWarning[];
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
type ValidateFn = ((data: unknown) => data is RegisterInput) & {
  errors?: ErrorObject[] | null;
};
const validateRegisterSchema = ajv.compile(REGISTER_JSON_SCHEMA) as ValidateFn;

export async function readRegisterInput(options: RegisterOptions): Promise<string> {
  if (options.file) {
    return readFileSync(options.file, 'utf8');
  }
  return await readStdin();
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new RefmeshValidationError(
      'No input provided. Pipe JSON via stdin or specify -f <path>.',
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseAndValidate(raw: string): RegisterInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RefmeshValidationError(`Invalid JSON: ${msg}`);
  }

  if (!validateRegisterSchema(parsed)) {
    const details = (validateRegisterSchema.errors ?? []).map(formatAjvError);
    throw new RefmeshValidationError('JSON schema validation failed.', details);
  }

  const input = parsed as RegisterInput;
  validateUniqueConceptIds(input);
  return input;
}

function formatAjvError(err: ErrorObject): string {
  const path = err.instancePath || '(root)';
  return `${path}: ${err.message ?? 'invalid'}${err.params ? ` ${JSON.stringify(err.params)}` : ''}`;
}

function validateUniqueConceptIds(input: RegisterInput): void {
  const seen = new Set<string>();
  const dups: string[] = [];
  for (const c of input.concepts) {
    if (seen.has(c.id)) {
      dups.push(c.id);
    }
    seen.add(c.id);
  }
  if (dups.length > 0) {
    throw new RefmeshValidationError('Duplicate concept ids in input.', dups);
  }
}

async function queryAll(
  conn: KuzuConnection,
  stmt: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> {
  if (Object.keys(params).length === 0) {
    const res = await conn.query(stmt);
    return res.getAll();
  }
  const prepared = await conn.prepare(stmt);
  const res = await conn.execute(prepared, params);
  return res.getAll();
}

async function resolveUnknownReferences(conn: KuzuConnection, input: RegisterInput): Promise<void> {
  const localIds = new Set(input.concepts.map((c) => c.id));
  const externalIds = new Set<string>();
  for (const rel of input.relationships) {
    if (!localIds.has(rel.source)) externalIds.add(rel.source);
    if (!localIds.has(rel.target)) externalIds.add(rel.target);
  }
  if (externalIds.size === 0) return;

  const missing: string[] = [];
  for (const id of externalIds) {
    const rows = await queryAll(conn, 'MATCH (c:Concept) WHERE c.id = $id RETURN c.id AS id', {
      id,
    });
    if (rows.length === 0) {
      missing.push(id);
    }
  }
  if (missing.length > 0) {
    throw new RefmeshValidationError(
      'Unresolved concept references. They are neither in concepts[] nor in the existing DB.',
      missing.map((id) => `unresolved id: ${id}`),
    );
  }
}

function validateRelationshipTypes(input: RegisterInput): void {
  const invalid: string[] = [];
  for (const rel of input.relationships) {
    if (!isPublicEdgeType(rel.type)) {
      invalid.push(`${rel.source} -[${rel.type}]-> ${rel.target}`);
    }
  }
  if (invalid.length > 0) {
    throw new RefmeshValidationError('Unknown edge type(s) in relationships.', invalid);
  }
}

async function findExistingConceptIds(conn: KuzuConnection, ids: string[]): Promise<Set<string>> {
  const existing = new Set<string>();
  for (const id of ids) {
    const rows = await queryAll(conn, 'MATCH (c:Concept) WHERE c.id = $id RETURN c.id AS id', {
      id,
    });
    if (rows.length > 0) existing.add(id);
  }
  return existing;
}

async function detectSimilarExistingConcepts(
  vector: VectorStore,
  candidates: { id: string; vec: number[] }[],
): Promise<SimilarConceptWarning[]> {
  const warnings: SimilarConceptWarning[] = [];
  for (const { id, vec } of candidates) {
    const hits = await vector.queryByVector(vec, {
      limit: 3,
      threshold: SAME_AS_SIMILARITY_THRESHOLD,
    });
    for (const hit of hits) {
      if (hit.id === id) continue;
      warnings.push({ newId: id, existingId: hit.id, score: hit.score });
      break;
    }
  }
  return warnings;
}

export async function executeRegister(
  stores: RefmeshHybridStores,
  input: RegisterInput,
): Promise<RegisterSummary> {
  const conn = stores.graph.connection;

  validateRelationshipTypes(input);
  await resolveUnknownReferences(conn, input);

  const texts = input.concepts.map((c) => composeConceptText(c));
  const vectors = await embedBatch(texts);

  const preExisting = await findExistingConceptIds(
    conn,
    input.concepts.map((c) => c.id),
  );
  const newConceptVectors = input.concepts
    .map((c, i) => ({ id: c.id, vec: vectors[i] ?? [] }))
    .filter(({ id }) => !preExisting.has(id));

  const similarWarnings = await detectSimilarExistingConcepts(stores.vector, newConceptVectors);

  const now = new Date();
  const fetchedAt = input.reference.fetchedAt ? new Date(input.reference.fetchedAt) : now;
  const publishedAt = input.reference.publishedAt
    ? new Date(input.reference.publishedAt)
    : undefined;

  await conn.query('BEGIN TRANSACTION');
  let referenceCreated: boolean;
  let describes = 0;
  const relByType: Record<string, number> = {};
  try {
    referenceCreated = await upsertReference(conn, input.reference, {
      now,
      fetchedAt,
      publishedAt,
    });
    for (const concept of input.concepts) {
      await upsertConcept(conn, concept, now);
    }

    for (const concept of input.concepts) {
      await createDescribesEdge(conn, input.reference.url, concept.id);
      describes += 1;
    }

    for (const rel of input.relationships) {
      await createRelationshipEdge(conn, rel);
      relByType[rel.type] = (relByType[rel.type] ?? 0) + 1;
    }

    await conn.query('COMMIT');
  } catch (err) {
    try {
      await conn.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw err;
  }

  const vectorRecords: VectorRecord[] = input.concepts.map((concept, i) => ({
    id: concept.id,
    text: texts[i] ?? '',
    vector: vectors[i] ?? [],
  }));
  await stores.vector.upsert(vectorRecords);

  return {
    reference: {
      url: input.reference.url,
      title: input.reference.title,
      created: referenceCreated,
    },
    conceptsUpserted: input.concepts.length,
    describesEdges: describes,
    relationshipsByType: relByType,
    vectorsUpserted: vectorRecords.length,
    similarWarnings,
  };
}

interface ReferenceTimestamps {
  now: Date;
  fetchedAt: Date;
  publishedAt?: Date;
}

async function upsertReference(
  conn: KuzuConnection,
  ref: RegisterInput['reference'],
  ts: ReferenceTimestamps,
): Promise<boolean> {
  const existing = await queryAll(
    conn,
    'MATCH (r:Reference) WHERE r.url = $url RETURN r.url AS url',
    { url: ref.url },
  );
  if (existing.length > 0) {
    if (ts.publishedAt !== undefined) {
      await queryAll(
        conn,
        `MATCH (r:Reference) WHERE r.url = $url
         SET r.title = $title, r.lastSeenAt = $now, r.fetchedAt = $fetchedAt, r.publishedAt = $publishedAt`,
        {
          url: ref.url,
          title: ref.title,
          now: ts.now,
          fetchedAt: ts.fetchedAt,
          publishedAt: ts.publishedAt,
        },
      );
    } else {
      await queryAll(
        conn,
        `MATCH (r:Reference) WHERE r.url = $url
         SET r.title = $title, r.lastSeenAt = $now, r.fetchedAt = $fetchedAt`,
        { url: ref.url, title: ref.title, now: ts.now, fetchedAt: ts.fetchedAt },
      );
    }
    return false;
  }
  if (ts.publishedAt !== undefined) {
    await queryAll(
      conn,
      `CREATE (r:Reference {
        url: $url, title: $title,
        firstSeenAt: $now, lastSeenAt: $now,
        fetchedAt: $fetchedAt, publishedAt: $publishedAt
      })`,
      {
        url: ref.url,
        title: ref.title,
        now: ts.now,
        fetchedAt: ts.fetchedAt,
        publishedAt: ts.publishedAt,
      },
    );
  } else {
    await queryAll(
      conn,
      `CREATE (r:Reference {
        url: $url, title: $title,
        firstSeenAt: $now, lastSeenAt: $now,
        fetchedAt: $fetchedAt
      })`,
      { url: ref.url, title: ref.title, now: ts.now, fetchedAt: ts.fetchedAt },
    );
  }
  return true;
}

async function upsertConcept(
  conn: KuzuConnection,
  concept: RegisterInput['concepts'][number],
  now: Date,
): Promise<void> {
  const existing = await queryAll(conn, 'MATCH (c:Concept) WHERE c.id = $id RETURN c.id AS id', {
    id: concept.id,
  });
  if (existing.length > 0) {
    await queryAll(
      conn,
      `MATCH (c:Concept) WHERE c.id = $id
       SET c.description = $description, c.details = $details,
           c.lastSeenAt = $now, c.touchCount = c.touchCount + 1`,
      {
        id: concept.id,
        description: concept.description,
        details: concept.details ?? '',
        now,
      },
    );
    return;
  }
  await queryAll(
    conn,
    `CREATE (c:Concept {
      id: $id, description: $description, details: $details,
      firstSeenAt: $now, lastSeenAt: $now,
      touchCount: 1, accessCount: 0
    })`,
    {
      id: concept.id,
      description: concept.description,
      details: concept.details ?? '',
      now,
    },
  );
}

async function createDescribesEdge(
  conn: KuzuConnection,
  url: string,
  conceptId: string,
): Promise<void> {
  const existing = await queryAll(
    conn,
    `MATCH (r:Reference)-[e:${INTERNAL_DESCRIBES_EDGE}]->(c:Concept)
     WHERE r.url = $url AND c.id = $id
     RETURN r.url AS url`,
    { url, id: conceptId },
  );
  if (existing.length > 0) return;

  await queryAll(
    conn,
    `MATCH (r:Reference), (c:Concept)
     WHERE r.url = $url AND c.id = $id
     CREATE (r)-[:${INTERNAL_DESCRIBES_EDGE}]->(c)`,
    { url, id: conceptId },
  );
}

async function createRelationshipEdge(
  conn: KuzuConnection,
  rel: RegisterInput['relationships'][number],
): Promise<void> {
  const existing = await queryAll(
    conn,
    `MATCH (a:Concept)-[e:${rel.type}]->(b:Concept)
     WHERE a.id = $source AND b.id = $target
     RETURN a.id AS src`,
    { source: rel.source, target: rel.target },
  );
  if (existing.length > 0) {
    await queryAll(
      conn,
      `MATCH (a:Concept)-[e:${rel.type}]->(b:Concept)
       WHERE a.id = $source AND b.id = $target
       SET e.reason = $reason`,
      { source: rel.source, target: rel.target, reason: rel.reason },
    );
    return;
  }
  await queryAll(
    conn,
    `MATCH (a:Concept), (b:Concept)
     WHERE a.id = $source AND b.id = $target
     CREATE (a)-[:${rel.type} {reason: $reason}]->(b)`,
    { source: rel.source, target: rel.target, reason: rel.reason },
  );
}

export function renderRegisterSummary(summary: RegisterSummary): string {
  const lines: string[] = [];
  lines.push(
    `Reference: ${summary.reference.url} ${summary.reference.created ? '(created)' : '(updated)'}`,
  );
  lines.push(`Concepts upserted: ${summary.conceptsUpserted}`);
  lines.push(`DESCRIBES edges ensured: ${summary.describesEdges}`);
  lines.push(`Vectors upserted: ${summary.vectorsUpserted}`);
  if (Object.keys(summary.relationshipsByType).length === 0) {
    lines.push('Relationships: (none)');
  } else {
    lines.push('Relationships:');
    for (const [type, count] of Object.entries(summary.relationshipsByType)) {
      lines.push(`  ${type}: ${count}`);
    }
  }
  if (summary.similarWarnings.length > 0) {
    lines.push('');
    lines.push('⚠ Similar existing concepts (consider reusing id or adding SAME_AS):');
    for (const w of summary.similarWarnings) {
      lines.push(`  - ${w.newId} ≈ ${w.existingId} (score=${w.score.toFixed(3)})`);
    }
  }
  return lines.join('\n');
}
