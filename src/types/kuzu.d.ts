declare module 'kuzu' {
  // Minimal surface used by refmesh. Expand as needed.
  export class Database {
    constructor(path: string, bufferPoolSize?: number);
    close?(): void;
  }

  export class Connection {
    constructor(db: Database);
    query(statement: string): Promise<QueryResult>;
    prepare(statement: string): Promise<PreparedStatement>;
    execute(prepared: PreparedStatement, params: Record<string, unknown>): Promise<QueryResult>;
    close?(): void;
  }

  export interface QueryResult {
    getAll(): Promise<Record<string, unknown>[]>;
    close?(): void;
  }

  export interface PreparedStatement {
    isSuccess?(): boolean;
  }

  const kuzu: {
    Database: typeof Database;
    Connection: typeof Connection;
  };
  export default kuzu;
}
