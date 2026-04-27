export { buildProgram, main } from './cli.js';
export { openStore, withStore, runAndClose, type RefmeshStore } from './db/store.js';
export {
  VectorIndex,
  type VectorRecord,
  type VectorQueryHit,
  type VectorQueryOptions,
} from './db/vector-index.js';
export {
  embed,
  embedBatch,
  composeConceptText,
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL_ID,
} from './embedding/embedder.js';
export {
  EDGE_TYPES,
  PUBLIC_EDGE_TYPES,
  PUBLIC_EDGE_TYPE_NAMES,
  INTERNAL_DESCRIBES_EDGE,
} from './schema/edge-types.js';
export { REGISTER_JSON_SCHEMA, type RegisterInput } from './schema/register-schema.js';
export { runTypesCommand } from './commands/types.js';
export {
  executeRegister,
  parseAndValidate,
  renderRegisterSummary,
  type RegisterSummary,
  type SimilarConceptWarning,
  SAME_AS_SIMILARITY_THRESHOLD,
} from './commands/register.js';
export {
  executeSearch,
  renderSearchText,
  renderSearchJson,
  DEFAULT_SEARCH_DEPTH,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SEARCH_THRESHOLD,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_DEMOTE_DEPRECATED,
  DEFAULT_LEXICAL_WEIGHT,
  DEFAULT_BM25_WEIGHT,
  type SearchOptions,
  type SearchResult,
  type SearchConceptNode,
} from './commands/search.js';
export {
  executeArchive,
  executeUnarchive,
  executePrune,
  renderArchiveResult,
  renderUnarchiveResult,
  renderPruneResult,
  type ArchiveResult,
  type UnarchiveResult,
  type PruneOptions,
  type PruneResult,
  type PruneCandidate,
} from './commands/archive.js';
