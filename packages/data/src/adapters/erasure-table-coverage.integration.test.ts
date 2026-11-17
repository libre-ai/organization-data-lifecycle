import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@libre-ai/testing";
import * as entry from "../index";
import {
  ErasureTableCoverageError,
  type ErasureTableCoverageOptions,
  inspectErasureTableCoverage,
} from "./erasure-table-coverage";
import type { SqlExecutor, SqlQueryResult } from "./executor";

/**
 * A product's exhaustiveness test in miniature: three fixture tables carry
 * the subject column, two are erased and one is retained on purpose. The
 * retained one has no grant for the application role, which is why the
 * comparison must run with the owner's executor.
 */

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const SCHEMA = "coverage_fx";
const DECLARED: ErasureTableCoverageOptions = {
  schema: SCHEMA,
  subjectColumn: "subject_digest",
  erasedTables: ["fx_messages", "fx_profiles"],
  retainedTables: ["fx_audit_trail"],
};

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase();
  await tdb.applyMigrations(MIGRATIONS_DIR);
  await tdb.db.exec(`
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.fx_messages (subject_digest text NOT NULL, body text NOT NULL);
    CREATE TABLE ${SCHEMA}.fx_profiles (subject_digest text NOT NULL, label text NOT NULL);
    CREATE TABLE ${SCHEMA}.fx_audit_trail (subject_digest text NOT NULL, action text NOT NULL);
    CREATE TABLE ${SCHEMA}.fx_settings (name text NOT NULL);
    GRANT USAGE ON SCHEMA ${SCHEMA} TO libre_ai_app;
    GRANT SELECT, INSERT, DELETE ON ${SCHEMA}.fx_messages, ${SCHEMA}.fx_profiles TO libre_ai_app;
  `);
});

afterAll(async () => {
  await tdb.close();
});

function spyExecutor(): { executor: SqlExecutor; calls: () => number } {
  let calls = 0;
  const executor: SqlExecutor = {
    query: async <R>(): Promise<SqlQueryResult<R>> => {
      calls += 1;
      return { rows: [] };
    },
    exec: async () => {
      calls += 1;
    },
  };
  return { executor, calls: () => calls };
}

describe("inspectErasureTableCoverage", () => {
  test("every table carrying the subject column is declared: nothing to report", async () => {
    expect(await inspectErasureTableCoverage(tdb.db, DECLARED)).toEqual({
      examined: 3,
      undeclared: [],
      missing: [],
    });
  });

  test("a table dropped from the erased list is the only undeclared one", async () => {
    const coverage = await inspectErasureTableCoverage(tdb.db, {
      ...DECLARED,
      erasedTables: ["fx_messages"],
    });
    expect(coverage).toEqual({ examined: 3, undeclared: ["fx_profiles"], missing: [] });
  });

  test("a declared table the schema does not contain is the only missing one", async () => {
    const coverage = await inspectErasureTableCoverage(tdb.db, {
      ...DECLARED,
      erasedTables: [...DECLARED.erasedTables, "fx_ghost"],
    });
    expect(coverage).toEqual({ examined: 3, undeclared: [], missing: ["fx_ghost"] });
  });

  test("a table without the subject column is missing when declared", async () => {
    const coverage = await inspectErasureTableCoverage(tdb.db, {
      ...DECLARED,
      retainedTables: [...DECLARED.retainedTables, "fx_settings"],
    });
    expect(coverage.missing).toEqual(["fx_settings"]);
  });

  test("a table in both lists is refused", async () => {
    await expect(
      inspectErasureTableCoverage(tdb.db, {
        ...DECLARED,
        retainedTables: ["fx_audit_trail", "fx_messages"],
      }),
    ).rejects.toThrow(ErasureTableCoverageError);
  });

  test.each([
    { label: "a quote in a table name", patch: { erasedTables: ['fx_messages"'] } },
    { label: "a semicolon in a table name", patch: { retainedTables: ["fx_audit_trail; --"] } },
    { label: "a quote in the schema name", patch: { schema: "coverage_fx'" } },
    { label: "a semicolon in the column name", patch: { subjectColumn: "subject_digest;" } },
  ])("$label is refused before any SQL is sent", async ({ patch }) => {
    const spy = spyExecutor();
    await expect(
      inspectErasureTableCoverage(spy.executor, { ...DECLARED, ...patch }),
    ).rejects.toThrow(ErasureTableCoverageError);
    expect(spy.calls()).toBe(0);
  });

  test("a subject column no table carries is an error, not an empty result", async () => {
    await expect(
      inspectErasureTableCoverage(tdb.db, { ...DECLARED, subjectColumn: "no_such_column" }),
    ).rejects.toThrow(ErasureTableCoverageError);
  });

  test("the owner's executor examines a table the application role has no grant on", async () => {
    const grants = await tdb.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.table_privileges
       WHERE table_schema = $1 AND table_name = 'fx_audit_trail' AND grantee = 'libre_ai_app'`,
      [SCHEMA],
    );
    expect(grants.rows[0]?.n).toBe(0);

    const coverage = await inspectErasureTableCoverage(tdb.db, {
      ...DECLARED,
      retainedTables: [],
    });
    expect(coverage).toEqual({ examined: 3, undeclared: ["fx_audit_trail"], missing: [] });
  });
});

describe("package entry", () => {
  test("exposes the coverage inspection and its error", () => {
    const exposed: Record<string, unknown> = entry;
    expect(exposed.inspectErasureTableCoverage).toBe(inspectErasureTableCoverage);
    expect(exposed.ErasureTableCoverageError).toBe(ErasureTableCoverageError);
    // Checked by the compiler: these annotations fail typecheck when one is missing.
    const options: entry.ErasureTableCoverageOptions = DECLARED;
    const coverage: entry.ErasureTableCoverage = { examined: 1, undeclared: [], missing: [] };
    expect(options.schema).toBe(SCHEMA);
    expect(coverage.examined).toBe(1);
  });
});
