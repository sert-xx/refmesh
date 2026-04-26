// Helpers for safely splicing user-controlled string ids into Cypher list
// literals. Kùzu's prepared statements only accept boolean / number / string /
// Date / BigInt parameters, so list-valued bindings (`$ids`) cannot be used —
// id batches must be inlined as escaped string literals.

export function escapeCypherString(value: string): string {
  // Match Kùzu's string-literal grammar: backslash is the escape character,
  // single-quote is delimiter. Escape backslashes first so the second pass
  // does not re-escape them.
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

export function cypherIdListLiteral(ids: readonly string[]): string {
  if (ids.length === 0) return '[]';
  return `[${ids.map((id) => `'${escapeCypherString(id)}'`).join(', ')}]`;
}
