/**
 * Minimal structural SQL surface the adapters need. PGlite satisfies it as-is
 * (query/exec); the G4 production driver must satisfy it too, so adapters and
 * their tests never depend on a concrete client.
 */
export interface SqlQueryResult<R> {
  readonly rows: R[];
  readonly affectedRows?: number;
}

export interface SqlExecutor {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<SqlQueryResult<R>>;
  exec(sql: string): Promise<unknown>;
}
