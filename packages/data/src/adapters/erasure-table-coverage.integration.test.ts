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
 * fixture is owned by a non-superuser role, as a product database is, and the
 * retained table has no grant for the application role.
 */

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const SCHEMA = "coverage_fx";
const KINDS_SCHEMA = "coverage_kinds";
const OWNER_ROLE = "coverage_owner";
const APP_ROLE = "libre_ai_app";
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
    CREATE ROLE ${OWNER_ROLE} NOLOGIN;
    CREATE SCHEMA ${SCHEMA} AUTHORIZATION ${OWNER_ROLE};
    CREATE SCHEMA ${KINDS_SCHEMA} AUTHORIZATION ${OWNER_ROLE};
    SET ROLE ${OWNER_ROLE};
    CREATE TABLE ${SCHEMA}.fx_messages (subject_digest text NOT NULL, body text NOT NULL);
    CREATE TABLE ${SCHEMA}.fx_profiles (subject_digest text NOT NULL, label text NOT NULL);
    CREATE TABLE ${SCHEMA}.fx_audit_trail (subject_digest text NOT NULL, action text NOT NULL);
    CREATE TABLE ${SCHEMA}.fx_settings (name text NOT NULL);
    GRANT USAGE ON SCHEMA ${SCHEMA} TO ${APP_ROLE};
    GRANT SELECT, INSERT, DELETE ON ${SCHEMA}.fx_messages, ${SCHEMA}.fx_profiles TO ${APP_ROLE};

    -- Every relation kind that can hold a copy of the subject column, plus an
    -- index and a dropped column that carry the name without holding data.
    CREATE TABLE ${KINDS_SCHEMA}.base (subject_digest text NOT NULL, body text NOT NULL);
    CREATE INDEX base_subject_idx ON ${KINDS_SCHEMA}.base (subject_digest);
    CREATE MATERIALIZED VIEW ${KINDS_SCHEMA}.mv_copy AS
      SELECT subject_digest, body FROM ${KINDS_SCHEMA}.base;
    CREATE VIEW ${KINDS_SCHEMA}.v_copy AS SELECT subject_digest FROM ${KINDS_SCHEMA}.base;
    CREATE TABLE ${KINDS_SCHEMA}.parted (subject_digest text NOT NULL, year int NOT NULL)
      PARTITION BY LIST (year);
    CREATE TABLE ${KINDS_SCHEMA}.parted_2026 PARTITION OF ${KINDS_SCHEMA}.parted FOR VALUES IN (2026);
    CREATE TABLE ${KINDS_SCHEMA}.dropped (subject_digest text, label text NOT NULL);
    ALTER TABLE ${KINDS_SCHEMA}.dropped DROP COLUMN subject_digest;
    RESET ROLE;
  `);
});

/** Runs `fn` with the session switched to `role`; the single PGlite session is restored after. */
async function asRole<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await tdb.db.exec(`SET ROLE ${role}`);
  try {
    return await fn();
  } finally {
    await tdb.db.exec("RESET ROLE");
  }
}

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
    const owner = await tdb.db.query<{ rolsuper: boolean }>(
      "SELECT rolsuper FROM pg_roles WHERE rolname = $1",
      [OWNER_ROLE],
    );
    expect(owner.rows).toEqual([{ rolsuper: false }]);
    const grants = await tdb.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.table_privileges
       WHERE table_schema = $1 AND table_name = 'fx_audit_trail' AND grantee = $2`,
      [SCHEMA, APP_ROLE],
    );
    expect(grants.rows[0]?.n).toBe(0);

    const coverage = await asRole(OWNER_ROLE, () =>
      inspectErasureTableCoverage(tdb.db, { ...DECLARED, retainedTables: [] }),
    );
    expect(coverage).toEqual({ examined: 3, undeclared: ["fx_audit_trail"], missing: [] });
  });

  test("the application role sees fewer tables through information_schema, all through the catalog", async () => {
    const viaInformationSchema = (role: string) =>
      asRole(role, async () => {
        const res = await tdb.db.query<{ n: number }>(
          `SELECT count(DISTINCT table_name)::int AS n FROM information_schema.columns
           WHERE table_schema = $1 AND column_name = $2`,
          [SCHEMA, DECLARED.subjectColumn],
        );
        return res.rows[0]?.n;
      });
    expect(await viaInformationSchema(OWNER_ROLE)).toBe(3);
    expect(await viaInformationSchema(APP_ROLE)).toBe(2);

    const coverage = await asRole(APP_ROLE, () => inspectErasureTableCoverage(tdb.db, DECLARED));
    expect(coverage).toEqual({ examined: 3, undeclared: [], missing: [] });
  });
});

describe("inspectErasureTableCoverage over every relation kind", () => {
  const KINDS: ErasureTableCoverageOptions = {
    schema: KINDS_SCHEMA,
    subjectColumn: "subject_digest",
    erasedTables: ["base", "parted"],
    retainedTables: ["v_copy"],
  };

  test("a materialized view copying the subject column is undeclared", async () => {
    const coverage = await asRole(OWNER_ROLE, () => inspectErasureTableCoverage(tdb.db, KINDS));
    expect(coverage.undeclared).toEqual(["mv_copy"]);
  });

  test("tables, partitioned parents and views are examined; partitions, indexes and dropped columns are not", async () => {
    const coverage = await asRole(OWNER_ROLE, () =>
      inspectErasureTableCoverage(tdb.db, {
        ...KINDS,
        erasedTables: [...KINDS.erasedTables, "mv_copy"],
      }),
    );
    expect(coverage).toEqual({ examined: 4, undeclared: [], missing: [] });
  });

  test("a partition declared on its own is missing: erasing through the parent covers it", async () => {
    const coverage = await asRole(OWNER_ROLE, () =>
      inspectErasureTableCoverage(tdb.db, {
        ...KINDS,
        erasedTables: [...KINDS.erasedTables, "mv_copy", "parted_2026"],
      }),
    );
    expect(coverage.missing).toEqual(["parted_2026"]);
  });

  test("a quoted mixed-case table is reported undeclared and cannot be declared (README)", async () => {
    await tdb.db.exec(`
      CREATE SCHEMA coverage_quoted AUTHORIZATION ${OWNER_ROLE};
      CREATE TABLE coverage_quoted.plain (subject_digest text NOT NULL);
      CREATE TABLE coverage_quoted."Shadow" (subject_digest text NOT NULL);
    `);
    const quoted: ErasureTableCoverageOptions = {
      schema: "coverage_quoted",
      subjectColumn: "subject_digest",
      erasedTables: ["plain"],
      retainedTables: [],
    };
    expect((await inspectErasureTableCoverage(tdb.db, quoted)).undeclared).toEqual(["Shadow"]);
    await expect(
      inspectErasureTableCoverage(tdb.db, { ...quoted, erasedTables: ["plain", "Shadow"] }),
    ).rejects.toThrow(ErasureTableCoverageError);
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
