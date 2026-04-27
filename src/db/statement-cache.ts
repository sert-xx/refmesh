import type Database from 'better-sqlite3';

// Lightweight prepared-statement cache. better-sqlite3's `prepare` is fast,
// but for hot paths (per-row inserts in register, freshness lookups during
// search) re-preparing the same SQL on every call still shows up in profiles.
// Wrapping it in a Map keyed by SQL text lets callers ask for a statement
// without manually threading singletons through every layer.
export class StatementCache {
  private readonly cache = new Map<string, Database.Statement>();

  constructor(private readonly db: Database.Database) {}

  get(sql: string): Database.Statement {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  clear(): void {
    this.cache.clear();
  }
}
