import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "@libre-ai/testing";
import type { SqlExecutor } from "./executor";
import {
  DuplicateMigrationIdError,
  InvalidMigrationIdError,
  type Migration,
  MigrationFailedError,
  migrate,
} from "./migration-runner";

/**
 * Tracked migration runner, on real PostgreSQL semantics (PGlite). Every
 * expectation below comes from the runner's contract, not from its output:
 * list order, never-replayed, one transaction per migration together with its
 * record, an advisory lock for the whole run.
 *
 * PGlite is single-connection: two runs on two sessions cannot be executed
 * here. The concurrency property is therefore proven by its two halves — the
 * lock is held for the whole run, and the applied set is read only once the
 * lock is granted — the second one by replaying, at the exact moment the lock
 * is requested, a competing run that finished first.
 */

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase();
});

// One engine for the file (PGlite start-up is the slow part), a blank
// database per test: no table, no record and no lock survives a test.
beforeEach(async () => {
  await tdb.db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await tdb.db.exec("SELECT pg_advisory_unlock_all()");
});

afterAll(async () => {
  await tdb.close();
});

/** A migration that issues one statement and records that it ran. */
function statementMigration(id: string, sql: string, runs: string[]): Migration {
  return {
    id,
    run: async (session) => {
      runs.push(id);
      await session.exec(sql);
    },
  };
}

/** Forwards every statement to `inner` after showing its text to `onStatement`. */
function observed(
  inner: SqlExecutor,
  onStatement: (sql: string) => void | Promise<void>,
): SqlExecutor {
  return {
    async query<R = Record<string, unknown>>(sql: string, params?: unknown[]) {
      await onStatement(sql);
      return inner.query<R>(sql, params);
    },
    async exec(sql: string) {
      await onStatement(sql);
      return inner.exec(sql);
    },
  };
}

async function recordedIds(): Promise<string[]> {
  const res = await tdb.db.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id");
  return res.rows.map((row) => row.id);
}

async function tableExists(table: string): Promise<boolean> {
  const res = await tdb.db.query<{ found: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS found",
    [table],
  );
  return res.rows[0]?.found === true;
}

async function advisoryLocksHeld(executor: SqlExecutor): Promise<number> {
  const res = await executor.query<{ held: number }>(
    "SELECT count(*)::int AS held FROM pg_locks WHERE locktype = 'advisory'",
  );
  return res.rows[0]?.held ?? -1;
}

describe("applying pending migrations", () => {
  test("none applied: both run in list order and are recorded in that order", async () => {
    // List order deliberately differs from lexical order: the list decides.
    const runs: string[] = [];
    const recordedBeforeSecond: string[] = [];
    const first = statementMigration("zeta", "CREATE TABLE zeta_things (n integer)", runs);
    const second: Migration = {
      id: "alpha",
      run: async (session) => {
        runs.push("alpha");
        const res = await session.query<{ id: string }>("SELECT id FROM schema_migrations");
        recordedBeforeSecond.push(...res.rows.map((row) => row.id));
        await session.exec("CREATE TABLE alpha_things (n integer)");
      },
    };

    await migrate(tdb.db, [first, second]);

    expect(runs).toEqual(["zeta", "alpha"]);
    expect(recordedBeforeSecond).toEqual(["zeta"]);
    expect(await recordedIds()).toEqual(["alpha", "zeta"]);
    expect(await tableExists("zeta_things")).toBe(true);
    expect(await tableExists("alpha_things")).toBe(true);
  });

  test("first already applied: only the second runs and is recorded", async () => {
    const runs: string[] = [];
    const first = statementMigration("0001_first", "CREATE TABLE first_things (n integer)", runs);
    const second = statementMigration(
      "0002_second",
      "CREATE TABLE second_things (n integer)",
      runs,
    );
    await migrate(tdb.db, [first]);
    expect(runs).toEqual(["0001_first"]);
    runs.length = 0;

    await migrate(tdb.db, [first, second]);

    expect(runs).toEqual(["0002_second"]);
    expect(await recordedIds()).toEqual(["0001_first", "0002_second"]);
  });

  test("replayable: a second start with the same list runs nothing", async () => {
    const runs: string[] = [];
    const list = [
      statementMigration("0001_first", "CREATE TABLE first_things (n integer)", runs),
      statementMigration("0002_second", "CREATE TABLE second_things (n integer)", runs),
    ];
    await migrate(tdb.db, list);
    runs.length = 0;

    await migrate(tdb.db, list);

    expect(runs).toEqual([]);
    expect(await recordedIds()).toEqual(["0001_first", "0002_second"]);
  });

  test("empty list: creates the tracking table, reads it, inserts nothing", async () => {
    const statements: string[] = [];

    await migrate(
      observed(tdb.db, (sql) => {
        statements.push(sql);
      }),
      [],
    );

    const columns = await tdb.db.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'schema_migrations' ORDER BY column_name`,
    );
    expect(columns.rows).toEqual([
      { column_name: "applied_at", data_type: "timestamp with time zone" },
      { column_name: "id", data_type: "text" },
    ]);
    const primaryKey = await tdb.db.query<{ column_name: string }>(
      `SELECT kcu.column_name FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu USING (constraint_name, table_name)
       WHERE tc.table_name = 'schema_migrations' AND tc.constraint_type = 'PRIMARY KEY'`,
    );
    expect(primaryKey.rows).toEqual([{ column_name: "id" }]);
    expect(statements.some((sql) => /^\s*SELECT\s+id\s+FROM\s+schema_migrations/i.test(sql))).toBe(
      true,
    );
    expect(statements.some((sql) => /INSERT/i.test(sql))).toBe(false);
    expect(await recordedIds()).toEqual([]);
  });
});

describe("journal", () => {
  test("receives exactly 'applying' then 'applied' per applied migration", async () => {
    const runs: string[] = [];
    const messages: string[] = [];
    const first = statementMigration("0001_first", "CREATE TABLE first_things (n integer)", runs);
    const second = statementMigration(
      "0002_second",
      "CREATE TABLE second_things (n integer)",
      runs,
    );
    await migrate(tdb.db, [first]);

    // The already-applied migration is silent: two messages per APPLIED one.
    await migrate(tdb.db, [first, second], (message) => messages.push(message));
    expect(messages).toEqual(["applying migration 0002_second", "0002_second applied"]);

    messages.length = 0;
    const third = statementMigration("0003_third", "CREATE TABLE third_things (n integer)", runs);
    const fourth = statementMigration(
      "0004_fourth",
      "CREATE TABLE fourth_things (n integer)",
      runs,
    );
    await migrate(tdb.db, [first, second, third, fourth], (message) => messages.push(message));
    expect(messages).toEqual([
      "applying migration 0003_third",
      "0003_third applied",
      "applying migration 0004_fourth",
      "0004_fourth applied",
    ]);
  });
});

describe("a failing migration", () => {
  test("rejects naming the migration, records nothing, and stops the run", async () => {
    const runs: string[] = [];
    const messages: string[] = [];
    const ok = statementMigration("0001_ok", "CREATE TABLE ok_things (n integer)", runs);
    const broken: Migration = {
      id: "0002_broken",
      run: async (session) => {
        runs.push("0002_broken");
        await session.exec("CREATE TABLE half_done (n integer)");
        throw new Error("boom with a row value");
      },
    };
    const never = statementMigration("0003_never", "CREATE TABLE never_things (n integer)", runs);

    const outcome = migrate(tdb.db, [ok, broken, never], (message) => messages.push(message));

    await expect(outcome).rejects.toBeInstanceOf(MigrationFailedError);
    await expect(outcome).rejects.toThrow("0002_broken");
    expect(runs).toEqual(["0001_ok", "0002_broken"]);
    // Nothing recorded for the failed one; the earlier success stays.
    expect(await recordedIds()).toEqual(["0001_ok"]);
    // Same transaction as its record: the partial schema change is undone.
    expect(await tableExists("half_done")).toBe(false);
    expect(await tableExists("ok_things")).toBe(true);
    expect(messages).toEqual([
      "applying migration 0001_ok",
      "0001_ok applied",
      "applying migration 0002_broken",
    ]);
  });

  test("keeps the cause as a property, never in the message", async () => {
    // A driver error can quote a row value; the message goes to logs.
    const cause = new Error("duplicate key: quoted-row-value");
    const broken: Migration = {
      id: "0001_broken",
      run: async () => {
        throw cause;
      },
    };

    let caught: unknown;
    try {
      await migrate(tdb.db, [broken]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MigrationFailedError);
    const failure = caught as MigrationFailedError;
    expect(failure.message).toBe("migration 0001_broken failed");
    expect(failure.migrationId).toBe("0001_broken");
    expect(failure.cause).toBe(cause);
  });

  test("a crash between a migration and its record leaves neither: the replay succeeds", async () => {
    const runs: string[] = [];
    const migration = statementMigration("0001_only", "CREATE TABLE only_things (n integer)", runs);
    const crashingOnRecord = observed(tdb.db, (sql) => {
      if (/INSERT\s+INTO\s+schema_migrations/i.test(sql)) {
        throw new Error("connection lost");
      }
    });

    await expect(migrate(crashingOnRecord, [migration])).rejects.toBeInstanceOf(
      MigrationFailedError,
    );
    expect(await tableExists("only_things")).toBe(false);
    expect(await recordedIds()).toEqual([]);

    // CREATE TABLE without IF NOT EXISTS: it would fail had the first try stuck.
    await migrate(tdb.db, [migration]);
    expect(runs).toEqual(["0001_only", "0001_only"]);
    expect(await tableExists("only_things")).toBe(true);
    expect(await recordedIds()).toEqual(["0001_only"]);
  });
});

describe("a failing migration whose clean-up fails too", () => {
  // The common real failure is a connection lost midway: the statement
  // rejects, and so does everything sent after it. The contract does not
  // bend: the run rejects naming the migration, driver text out of the message.

  test("session lost while recording: ROLLBACK and unlock reject, the migration is still named", async () => {
    const runs: string[] = [];
    const migration = statementMigration("0001_only", "CREATE TABLE only_things (n integer)", runs);
    const driverErrors: Error[] = [];
    let lost = false;
    const lostSession = observed(tdb.db, (sql) => {
      if (/INSERT\s+INTO\s+schema_migrations/i.test(sql)) {
        lost = true;
      }
      if (lost) {
        const error = new Error("connection lost: quoted-row-value");
        driverErrors.push(error);
        throw error;
      }
    });

    let caught: unknown;
    try {
      await migrate(lostSession, [migration]);
    } catch (error) {
      caught = error;
    } finally {
      // Stand-in for the server, which aborts the transaction of a lost session.
      await tdb.db.exec("ROLLBACK");
    }

    expect(caught).toBeInstanceOf(MigrationFailedError);
    const failure = caught as MigrationFailedError;
    expect(failure.message).toBe("migration 0001_only failed");
    expect(failure.migrationId).toBe("0001_only");
    // The first rejection is the cause; ROLLBACK and unlock were both attempted.
    expect(driverErrors).toHaveLength(3);
    expect(failure.cause).toBe(driverErrors[0]);
  });

  test("unlock rejected after a failed migration: the migration is still named", async () => {
    const cause = new Error("boom");
    const broken: Migration = {
      id: "0001_broken",
      run: async () => {
        throw cause;
      },
    };
    let unlockAttempts = 0;
    const failingUnlock = observed(tdb.db, (sql) => {
      if (/pg_advisory_unlock/i.test(sql)) {
        unlockAttempts += 1;
        throw new Error("connection lost on unlock");
      }
    });

    let caught: unknown;
    try {
      await migrate(failingUnlock, [broken]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MigrationFailedError);
    const failure = caught as MigrationFailedError;
    expect(failure.message).toBe("migration 0001_broken failed");
    expect(failure.cause).toBe(cause);
    expect(unlockAttempts).toBe(1);
  });

  test("BEGIN rejected: the announced migration is named and never runs", async () => {
    const runs: string[] = [];
    const messages: string[] = [];
    const migration = statementMigration("0001_only", "CREATE TABLE only_things (n integer)", runs);
    const beginFailure = new Error("connection lost on begin");
    const failingBegin = observed(tdb.db, (sql) => {
      if (/^\s*BEGIN\b/i.test(sql)) {
        throw beginFailure;
      }
    });

    let caught: unknown;
    try {
      await migrate(failingBegin, [migration], (message) => messages.push(message));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MigrationFailedError);
    const failure = caught as MigrationFailedError;
    expect(failure.message).toBe("migration 0001_only failed");
    expect(failure.cause).toBe(beginFailure);
    expect(runs).toEqual([]);
    expect(messages).toEqual(["applying migration 0001_only"]);
    expect(await recordedIds()).toEqual([]);
    expect(await advisoryLocksHeld(tdb.db)).toBe(0);
  });

  test("unlock rejected after a clean run: that rejection is the outcome, not swallowed", async () => {
    const runs: string[] = [];
    const migration = statementMigration("0001_only", "CREATE TABLE only_things (n integer)", runs);
    const unlockFailure = new Error("connection lost on unlock");
    const failingUnlock = observed(tdb.db, (sql) => {
      if (/pg_advisory_unlock/i.test(sql)) {
        throw unlockFailure;
      }
    });

    await expect(migrate(failingUnlock, [migration])).rejects.toBe(unlockFailure);

    // The migration itself went through: applied and recorded.
    expect(await recordedIds()).toEqual(["0001_only"]);
  });
});

describe("concurrent starts", () => {
  test("holds one advisory lock during every migration and releases it after the run", async () => {
    const heldDuringRun: number[] = [];
    const probe = (id: string): Migration => ({
      id,
      run: async (session) => {
        heldDuringRun.push(await advisoryLocksHeld(session));
      },
    });

    await migrate(tdb.db, [probe("0001_first"), probe("0002_second")]);

    expect(heldDuringRun).toEqual([1, 1]);
    expect(await advisoryLocksHeld(tdb.db)).toBe(0);
  });

  test("releases the advisory lock when a migration fails", async () => {
    const broken: Migration = {
      id: "0001_broken",
      run: async () => {
        throw new Error("boom");
      },
    };

    await expect(migrate(tdb.db, [broken])).rejects.toBeInstanceOf(MigrationFailedError);

    expect(await advisoryLocksHeld(tdb.db)).toBe(0);
  });

  test("a competing run that finished while this one waited for the lock is not replayed", async () => {
    const runs: string[] = [];
    const first = statementMigration("0001_first", "CREATE TABLE first_things (n integer)", runs);
    const second = statementMigration(
      "0002_second",
      "CREATE TABLE second_things (n integer)",
      runs,
    );
    let lockRequests = 0;
    const waitingBehindCompetitor = observed(tdb.db, async (sql) => {
      if (/pg_advisory(_xact)?_lock/i.test(sql)) {
        lockRequests += 1;
        if (lockRequests === 1) {
          // The competitor held the lock, applied everything, released it.
          await migrate(tdb.db, [first, second]);
        }
      }
    });

    await migrate(waitingBehindCompetitor, [first, second]);

    expect(lockRequests).toBe(1);
    // Each migration applied exactly once across the two runs.
    expect(runs).toEqual(["0001_first", "0002_second"]);
    expect(await recordedIds()).toEqual(["0001_first", "0002_second"]);
  });
});

describe("migration list validation", () => {
  test("refuses a malformed identifier before any SQL is sent, without echoing it", async () => {
    const statements: string[] = [];
    const spy = observed(tdb.db, (sql) => {
      statements.push(sql);
    });
    const noop = async (): Promise<void> => {};

    for (const id of ["", "has space", "line\nbreak", "-leading-dash", "x".repeat(129)]) {
      const outcome = migrate(spy, [{ id, run: noop }]);
      await expect(outcome).rejects.toBeInstanceOf(InvalidMigrationIdError);
      await expect(outcome).rejects.toThrow(`a ${id.length}-char value`);
    }
    expect(statements).toEqual([]);
  });

  test("refuses an identifier that is not a string before any SQL is sent, without echoing it", async () => {
    // A list built from data by an untyped caller: `undefined`, `null` and a
    // number all read as a well-formed identifier once coerced to text.
    const statements: string[] = [];
    const spy = observed(tdb.db, (sql) => {
      statements.push(sql);
    });
    const noop = async (): Promise<void> => {};

    for (const id of [undefined, null, 42, { toString: () => "0001_forged" }]) {
      const outcome = migrate(spy, [{ id: id as unknown as string, run: noop }]);
      await expect(outcome).rejects.toBeInstanceOf(InvalidMigrationIdError);
      await expect(outcome).rejects.toThrow(
        `malformed migration identifier (a ${typeof id} value)`,
      );
    }
    expect(statements).toEqual([]);
  });

  test("refuses a list naming the same identifier twice before any SQL is sent", async () => {
    const statements: string[] = [];
    const spy = observed(tdb.db, (sql) => {
      statements.push(sql);
    });
    const runs: string[] = [];
    const once = statementMigration("0001_same", "CREATE TABLE same_things (n integer)", runs);

    const outcome = migrate(spy, [once, once]);

    await expect(outcome).rejects.toBeInstanceOf(DuplicateMigrationIdError);
    await expect(outcome).rejects.toThrow("0001_same");
    expect(statements).toEqual([]);
    expect(runs).toEqual([]);
  });
});
