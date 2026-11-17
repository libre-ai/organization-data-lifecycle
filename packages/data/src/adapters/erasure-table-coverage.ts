import type { SqlExecutor } from "./executor";

/**
 * Compares the tables a product declares for an erasure with the tables of its
 * schema that actually carry the subject column. A table added by a migration
 * and forgotten in the product's deletion shows up in `undeclared`; a declared
 * table the schema no longer has shows up in `missing`.
 *
 * The relations are read from the system catalog (`pg_attribute`, `pg_class`,
 * `pg_namespace`), not from `information_schema.columns`: the latter hides
 * materialized views and every relation the current role neither owns nor
 * holds a privilege on, so a copy of the subject column could escape the
 * comparison. Every relation kind that can hold or expose the column is
 * examined: ordinary and partitioned tables, materialized and plain views,
 * foreign tables. Partitions are not: erasing through the partitioned parent
 * covers them. Indexes and dropped columns carry no data of their own.
 *
 * Names are matched as stored in the catalog, so a quoted mixed-case table
 * (`"Shadow"`) is reported as undeclared but cannot be declared: the
 * identifier shape is lower-case only. Rename such a table.
 */
export class ErasureTableCoverageError extends Error {
  constructor(defect: string) {
    super(`erasure table coverage: ${defect}`);
    this.name = "ErasureTableCoverageError";
  }
}

// Same identifier shape as expired-selection-query.ts, which does not export it.
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

// pg_class.relkind: ordinary table, partitioned table, materialized view, view, foreign table.
const EXAMINED_RELATION_KINDS: readonly string[] = ["r", "p", "m", "v", "f"];

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
    `SELECT c.relname AS table_name
     FROM pg_catalog.pg_attribute a
     JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND a.attname = $2
       AND a.attnum > 0 AND NOT a.attisdropped
       AND c.relkind = ANY ($3::"char"[]) AND NOT c.relispartition
     ORDER BY c.relname`,
    [options.schema, options.subjectColumn, EXAMINED_RELATION_KINDS],
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
