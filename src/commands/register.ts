import { readFileSync } from 'node:fs';
import AjvModule, { type ErrorObject } from 'ajv';
import addFormatsModule from 'ajv-formats';
import {
  ensureDescribes,
  ensureEdge,
  existingConceptIds,
  upsertConcept,
  upsertReference,
} from '../db/concept-repo.js';
import type { RefmeshStore } from '../db/store.js';
import { composeConceptText, embedBatch } from '../embedding/embedder.js';
import { isPublicEdgeType } from '../schema/edge-types.js';
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

function resolveUnknownReferences(store: RefmeshStore, input: RegisterInput): void {
  const localIds = new Set(input.concepts.map((c) => c.id));
  const externalIds: string[] = [];
  for (const rel of input.relationships) {
    if (!localIds.has(rel.source)) externalIds.push(rel.source);
    if (!localIds.has(rel.target)) externalIds.push(rel.target);
  }
  if (externalIds.length === 0) return;
  const existing = existingConceptIds(store.db, externalIds);
  const missing = externalIds.filter((id) => !existing.has(id));
  if (missing.length > 0) {
    throw new RefmeshValidationError(
      'Unresolved concept references. They are neither in concepts[] nor in the existing DB.',
      missing.map((id) => `unresolved id: ${id}`),
    );
  }
}

function detectSimilarExistingConcepts(
  store: RefmeshStore,
  candidates: { id: string; vec: number[] }[],
): SimilarConceptWarning[] {
  const warnings: SimilarConceptWarning[] = [];
  for (const { id, vec } of candidates) {
    const hits = store.vectors.query(vec, {
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
  store: RefmeshStore,
  input: RegisterInput,
): Promise<RegisterSummary> {
  validateRelationshipTypes(input);
  resolveUnknownReferences(store, input);

  const texts = input.concepts.map((c) => composeConceptText(c));
  const vectors = await embedBatch(texts);

  // SAME_AS warnings only make sense for genuinely new concepts. Comparing a
  // concept against itself in the in-memory index would always trigger the
  // 0.95 threshold and noise up the summary.
  const preExisting = existingConceptIds(
    store.db,
    input.concepts.map((c) => c.id),
  );
  const newConceptVectors = input.concepts
    .map((c, i) => ({ id: c.id, vec: vectors[i] ?? [] }))
    .filter(({ id }) => !preExisting.has(id));
  const similarWarnings = detectSimilarExistingConcepts(store, newConceptVectors);

  const now = new Date();
  const nowIso = now.toISOString();
  const fetchedAt = input.reference.fetchedAt ? new Date(input.reference.fetchedAt) : now;
  const publishedAt = input.reference.publishedAt
    ? new Date(input.reference.publishedAt)
    : undefined;

  let referenceCreated = false;
  let describes = 0;
  const relByType: Record<string, number> = {};

  // BEGIN IMMEDIATE wraps everything in one ACID unit. If any step throws
  // (validation drift, FK violation, CHECK miss, etc.) better-sqlite3
  // automatically rolls back AND we never touch the in-memory vector index,
  // so a failed register cannot leave behind half-written rows OR half-
  // updated vectors.
  store.transaction(() => {
    const refResult = upsertReference(
      store.db,
      {
        url: input.reference.url,
        title: input.reference.title,
        publishedAt,
        fetchedAt,
      },
      nowIso,
    );
    referenceCreated = refResult.created;

    for (const concept of input.concepts) {
      upsertConcept(store.db, concept, nowIso);
    }
    for (const concept of input.concepts) {
      ensureDescribes(store.db, input.reference.url, concept.id);
      describes += 1;
    }
    for (const rel of input.relationships) {
      ensureEdge(store.db, rel.source, rel.type, rel.target, rel.reason);
      relByType[rel.type] = (relByType[rel.type] ?? 0) + 1;
    }
    store.vectors.upsert(input.concepts.map((c, i) => ({ id: c.id, vector: vectors[i] ?? [] })));
  });

  return {
    reference: {
      url: input.reference.url,
      title: input.reference.title,
      created: referenceCreated,
    },
    conceptsUpserted: input.concepts.length,
    describesEdges: describes,
    relationshipsByType: relByType,
    vectorsUpserted: input.concepts.length,
    similarWarnings,
  };
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
