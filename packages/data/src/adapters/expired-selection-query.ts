import type { SqlExecutor } from "./executor";

/**
 * SQL twin of the pure expired-selection module: opaque row ids whose age
 * reached the retention window at a caller-supplied instant (no wall-clock
 * read — deterministic, reproducible evidence). Runs under the tenant
 * transaction, so RLS scopes the scan to the active tenant.
 *
 * The table name is the only non-parameterizable fragment; it is validated
 * against a strict identifier shape and quoted, and anything else is refused
 * before any SQL is sent.
 */
export class UnsafeTableNameError extends Error {
  constructor(table: string) {
    super(`unsafe table identifier ${JSON.stringify(table)}`);
    this.name = "UnsafeTableNameError";
  }
}

const SAFE_TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

export interface ExpiredSelectionOptions {
  readonly now: string;
  readonly retentionDays: number;
}

interface ExpiredRow {
  readonly id: string;
}

export async function selectExpiredRowIds(
  executor: SqlExecutor,
  table: string,
  options: ExpiredSelectionOptions,
): Promise<string[]> {
  if (!SAFE_TABLE_NAME.test(table)) {
    throw new UnsafeTableNameError(table);
  }
  if (!Number.isInteger(options.retentionDays) || options.retentionDays <= 0) {
    throw new RangeError(`retentionDays must be a positive integer, got ${options.retentionDays}`);
  }
  const res = await executor.query<ExpiredRow>(
    `SELECT id FROM "${table}"
     WHERE created_at + make_interval(days => $1) <= $2::timestamptz
     ORDER BY id`,
    [options.retentionDays, options.now],
  );
  return res.rows.map((row) => row.id);
}
