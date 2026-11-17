import type { SqlExecutor } from "./executor";

/**
 * Compares the tables a product declares for an erasure with the tables of its
 * schema that actually carry the subject column. A table added by a migration
 * and forgotten in the product's deletion shows up in `undeclared`; a declared
 * table the schema no longer has shows up in `missing`.
 *
 * `information_schema.columns` only lists what the current role owns or holds
 * a privilege on: call this with the database owner's executor, otherwise an
 * ungranted table is invisible and the comparison says nothing about it. Views
 * carrying the column are listed too and must be declared like tables.
 */
export class ErasureTableCoverageError extends Error {
  constructor(defect: string) {
    super(`erasure table coverage: ${defect}`);
    this.name = "ErasureTableCoverageError";
  }
}

// Same identifier shape as expired-selection-query.ts, which does not export it.
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

export interface ErasureTableCoverageOptions {
  readonly schema: string;
  readonly subjectColumn: string;
  /** Tables the product erases for a subject. */
  readonly erasedTables: readonly string[];
  /** Tables kept on purpose (Art. 17(3), append-only audit trails). */
  readonly retainedTables: readonly string[];
}

export interface ErasureTableCoverage {
  /** Number of tables of the schema carrying the subject column; never zero. */
  readonly examined: number;
  /** Tables carrying the subject column that neither list declares. */
  readonly undeclared: readonly string[];
  /** Declared tables the schema does not contain with that column. */
  readonly missing: readonly string[];
}

interface ColumnRow {
  readonly table_name: string;
}

function requireIdentifier(kind: string, value: string): void {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) {
    throw new ErasureTableCoverageError(`unsafe ${kind} identifier ${JSON.stringify(value)}`);
  }
}

export async function inspectErasureTableCoverage(
  executor: SqlExecutor,
  options: ErasureTableCoverageOptions,
): Promise<ErasureTableCoverage> {
  requireIdentifier("schema", options.schema);
  requireIdentifier("column", options.subjectColumn);
  for (const table of [...options.erasedTables, ...options.retainedTables]) {
    requireIdentifier("table", table);
  }
  const erased = new Set(options.erasedTables);
  for (const table of options.retainedTables) {
    if (erased.has(table)) {
      throw new ErasureTableCoverageError(`table "${table}" is declared both erased and retained`);
    }
  }
  const declared = new Set([...options.erasedTables, ...options.retainedTables]);

  const res = await executor.query<ColumnRow>(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = $1 AND column_name = $2
     ORDER BY table_name`,
    [options.schema, options.subjectColumn],
  );
  const present = new Set(res.rows.map((row) => row.table_name));
  // Zero tables examined is an unreadable or misnamed source, not a clean result.
  if (present.size === 0) {
    throw new ErasureTableCoverageError(
      `no table of schema "${options.schema}" carries column "${options.subjectColumn}"`,
    );
  }

  return {
    examined: present.size,
    undeclared: [...present].filter((table) => !declared.has(table)).sort(),
    missing: [...declared].filter((table) => !present.has(table)).sort(),
  };
}
