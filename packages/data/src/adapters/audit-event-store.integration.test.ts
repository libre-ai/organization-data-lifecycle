import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@libre-ai/testing";
import { type AuditEventInput, InvalidAuditEventError } from "../audit-event";
import { MissingTenantContextError } from "../tenant-context";
import {
  type AuditStoreFailure,
  appendAuditEvent,
  OpenTenantTransactionError,
  recordAuditEventBestEffort,
} from "./audit-event-store";
import type { SqlExecutor } from "./executor";
import { withTenantDbTransaction } from "./tenant-transaction";

/**
 * Audit event table and store, on real PostgreSQL semantics (PGlite).
 *
 * The first half proves the database barrier in raw SQL, without the store:
 * forced row security, cross-tenant denial, append-only grants, structural
 * CHECKs. The second half proves the two write modes: the evidential one
 * fails the operation it traces, the comfort one absorbs a storage failure
 * but reports it.
 */

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const TENANT_A = "ten_aaaaaaaaaaaaaaaa";
const TENANT_B = "ten_bbbbbbbbbbbbbbbb";

const RAW_INSERT = `INSERT INTO audit_events
  (tenant_id, event_id, action, actor_id, actor_role, resource, outcome, severity, context, occurred_at)
  VALUES ($1, $2, 'request.transition', 'usr_0001', NULL, NULL, $3, $4, $5::jsonb, '2026-11-17T10:00:00Z')`;

let tdb: TestDatabase;

/** Runs raw SQL as the application role under `tenant`, then rolls back. */
async function asTenant<T>(tenant: string | null, fn: () => Promise<T>): Promise<T> {
  await tdb.db.exec("BEGIN");
  try {
    await tdb.db.exec("SET LOCAL ROLE libre_ai_app");
    if (tenant !== null) {
      await tdb.db.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    }
    return await fn();
  } finally {
    await tdb.db.exec("ROLLBACK");
  }
}

/** Seeds one line as the migration owner (bypasses RLS, not the CHECKs). */
async function seed(tenant: string, eventId: string): Promise<void> {
  await tdb.db.query(RAW_INSERT, [tenant, eventId, "success", "info", "{}"]);
}

async function visibleEventIds(tenant: string | null): Promise<string[]> {
  return asTenant(tenant, async () => {
    const res = await tdb.db.query<{ event_id: string }>(
      "SELECT event_id FROM audit_events ORDER BY occurred_at, event_id",
    );
    return res.rows.map((row) => row.event_id);
  });
}

const OWNER_COUNT_QUERIES = {
  audit_events: "SELECT count(*)::int AS n FROM audit_events",
  fixture_requests: "SELECT count(*)::int AS n FROM fixture_requests",
} as const;

async function ownerCount(table: keyof typeof OWNER_COUNT_QUERIES): Promise<number> {
  const res = await tdb.db.query<{ n: number }>(OWNER_COUNT_QUERIES[table]);
  return res.rows[0]?.n ?? -1;
}

function eventInput(id: string, occurredAt: string): AuditEventInput {
  return {
    id,
    action: "request.transition",
    actorId: "usr_0001",
    outcome: "success",
    occurredAt,
  };
}

interface Spy {
  readonly executor: SqlExecutor;
  readonly statements: string[];
}

/** Records every statement; forwards to `inner` unless `failOn` matches. */
function spyOn(inner: SqlExecutor | null, failOn?: RegExp): Spy {
  const statements: string[] = [];
  const guard = (sql: string): void => {
    statements.push(sql);
    if (failOn?.test(sql)) {
      throw new StorageDownError();
    }
  };
  return {
    statements,
    executor: {
      async query<R = Record<string, unknown>>(sql: string, params?: unknown[]) {
        guard(sql);
        if (inner === null) {
          return { rows: [] as R[] };
        }
        return inner.query<R>(sql, params);
      },
      async exec(sql: string) {
        guard(sql);
        return inner === null ? undefined : inner.exec(sql);
      },
    },
  };
}

class StorageDownError extends Error {
  constructor() {
    super("storage is down");
    this.name = "StorageDownError";
  }
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  await tdb.applyMigrations(MIGRATIONS_DIR);
  // Product-style business table, provisioned like any owner table would be.
  await tdb.db.exec(`
    CREATE TABLE fixture_requests (
      tenant_id text NOT NULL CHECK (tenant_id ~ '^ten_[a-z0-9]{16,64}$'),
      id text NOT NULL,
      PRIMARY KEY (tenant_id, id)
    );
    ALTER TABLE fixture_requests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE fixture_requests FORCE ROW LEVEL SECURITY;
    CREATE POLICY fixture_requests_tenant_isolation ON fixture_requests
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
    GRANT SELECT, INSERT ON fixture_requests TO libre_ai_app;
  `);
});

// Owner-side reset: no line survives a test, so every count below is exact.
beforeEach(async () => {
  await tdb.db.exec("TRUNCATE audit_events; TRUNCATE fixture_requests;");
});

afterAll(async () => {
  await tdb.close();
});

describe("database barrier (raw SQL, no store)", () => {
  test("row security is enabled AND forced on audit_events", async () => {
    const res = await tdb.db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'audit_events'",
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.relrowsecurity).toBe(true);
    expect(res.rows[0]?.relforcerowsecurity).toBe(true);
  });

  test("cross read: A sees its two lines, B its one, no context sees none", async () => {
    await seed(TENANT_A, "evt_a1");
    await seed(TENANT_A, "evt_a2");
    await seed(TENANT_B, "evt_b1");
    expect(await visibleEventIds(TENANT_A)).toEqual(["evt_a1", "evt_a2"]);
    expect(await visibleEventIds(TENANT_B)).toEqual(["evt_b1"]);
    expect(await visibleEventIds(null)).toEqual([]);
  });

  test("an INSERT under A carrying B's tenant_id is denied by row security", async () => {
    await asTenant(TENANT_A, async () => {
      await expect(
        tdb.db.query(RAW_INSERT, [TENANT_B, "evt_cross", "success", "info", "{}"]),
      ).rejects.toThrow(/row-level security/);
    });
    expect(await ownerCount("audit_events")).toBe(0);
  });

  test("the application role may INSERT its own line", async () => {
    await asTenant(TENANT_A, async () => {
      await tdb.db.query(RAW_INSERT, [TENANT_A, "evt_own", "success", "info", "{}"]);
      const res = await tdb.db.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_events");
      expect(res.rows[0]?.n).toBe(1);
    });
  });

  const refusedWrites: ReadonlyArray<readonly [verb: string, attempt: () => Promise<unknown>]> = [
    ["UPDATE", () => tdb.db.exec("UPDATE audit_events SET action = 'rewritten'")],
    ["DELETE", () => tdb.db.exec("DELETE FROM audit_events")],
    ["TRUNCATE", () => tdb.db.exec("TRUNCATE audit_events")],
  ];
  for (const [verb, attempt] of refusedWrites) {
    test(`the application role is refused: ${verb}`, async () => {
      await seed(TENANT_A, "evt_kept");
      await asTenant(TENANT_A, async () => {
        await expect(attempt()).rejects.toThrow(/permission denied/);
      });
      expect(await ownerCount("audit_events")).toBe(1);
    });
  }

  test("libre_ai_retention holds no privilege on audit_events", async () => {
    const res = await tdb.db.query<{ privilege: string; granted: boolean }>(
      `SELECT privilege, has_table_privilege('libre_ai_retention', 'audit_events', privilege) AS granted
       FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS privilege
       ORDER BY privilege`,
    );
    expect(res.rows).toEqual([
      { privilege: "DELETE", granted: false },
      { privilege: "INSERT", granted: false },
      { privilege: "SELECT", granted: false },
      { privilege: "UPDATE", granted: false },
    ]);
  });

  test("libre_ai_app holds SELECT and INSERT, and nothing else", async () => {
    const res = await tdb.db.query<{ privilege: string; granted: boolean }>(
      `SELECT privilege, has_table_privilege('libre_ai_app', 'audit_events', privilege) AS granted
       FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS privilege
       ORDER BY privilege`,
    );
    expect(res.rows).toEqual([
      { privilege: "DELETE", granted: false },
      { privilege: "INSERT", granted: true },
      { privilege: "SELECT", granted: true },
      { privilege: "TRUNCATE", granted: false },
      { privilege: "UPDATE", granted: false },
    ]);
  });

  const structural: ReadonlyArray<readonly [label: string, params: readonly string[]]> = [
    ["an outcome outside the enumeration", [TENANT_A, "evt_bad", "maybe", "info", "{}"]],
    ["a severity outside the enumeration", [TENANT_A, "evt_bad", "success", "urgent", "{}"]],
    ["a context that is a JSON array", [TENANT_A, "evt_bad", "success", "info", "[]"]],
    ["a context that is a JSON string", [TENANT_A, "evt_bad", "success", "info", '"text"']],
    ["a malformed tenant id", ["ten_UPPER", "evt_bad", "success", "info", "{}"]],
  ];
  for (const [label, params] of structural) {
    test(`the owner itself cannot persist ${label}`, async () => {
      await expect(tdb.db.query(RAW_INSERT, [...params])).rejects.toThrow(
        /check constraint|violates/,
      );
      expect(await ownerCount("audit_events")).toBe(0);
    });
  }
});

describe("appendAuditEvent (evidential mode)", () => {
  test("two appends in one tenant transaction leave exactly two lines, in order", async () => {
    await withTenantDbTransaction(tdb.db, TENANT_A, async (tx) => {
      // Written latest first: the read order is the timestamps', not the writes'.
      await appendAuditEvent(tx, eventInput("evt_2", "2026-11-17T11:00:00Z"));
      await appendAuditEvent(tx, eventInput("evt_1", "2026-11-17T10:00:00Z"));
    });
    expect(await ownerCount("audit_events")).toBe(2);
    expect(await visibleEventIds(TENANT_A)).toEqual(["evt_1", "evt_2"]);
    expect(await visibleEventIds(TENANT_B)).toEqual([]);
  });

  test("every column is stored from the validated event", async () => {
    const returned = await withTenantDbTransaction(tdb.db, TENANT_A, (tx) =>
      appendAuditEvent(tx, {
        id: "evt_full",
        action: "rule.change",
        actorId: "usr_0002",
        actorRole: "case_officer",
        resource: "request/req_0001",
        outcome: "denied",
        severity: "high",
        context: { step: "review", attempt: 2 },
        occurredAt: "2026-11-17T12:30:00+02:00",
      }),
    );
    expect(returned.severity).toBe("high");
    const res = await tdb.db.query(
      `SELECT tenant_id, event_id, action, actor_id, actor_role, resource, outcome, severity, context,
              occurred_at = '2026-11-17T10:30:00Z'::timestamptz AS same_instant
       FROM audit_events`,
    );
    expect(res.rows).toEqual([
      {
        tenant_id: TENANT_A,
        event_id: "evt_full",
        action: "rule.change",
        actor_id: "usr_0002",
        actor_role: "case_officer",
        resource: "request/req_0001",
        outcome: "denied",
        severity: "high",
        context: { step: "review", attempt: 2 },
        same_instant: true,
      },
    ]);
  });

  test("defaults reach the table: severity info, empty context, NULL role and resource", async () => {
    await withTenantDbTransaction(tdb.db, TENANT_A, (tx) =>
      appendAuditEvent(tx, eventInput("evt_min", "2026-11-17T10:00:00Z")),
    );
    const res = await tdb.db.query(
      "SELECT actor_role, resource, severity, context FROM audit_events",
    );
    expect(res.rows).toEqual([{ actor_role: null, resource: null, severity: "info", context: {} }]);
  });

  test("accepted timestamp bounds and a __proto__ context key are stored as given", async () => {
    const bounds = [
      "0001-01-01T00:00:00Z",
      "2024-02-29T10:00:00Z",
      "2026-11-17T23:59:59.999999Z",
      "2026-11-17T10:00:00.5-14:00",
      "2026-11-17T10:00+14:00",
    ];
    await withTenantDbTransaction(tdb.db, TENANT_A, async (tx) => {
      for (const [index, occurredAt] of bounds.entries()) {
        await appendAuditEvent(tx, {
          ...eventInput(`evt_${index}`, occurredAt),
          context: JSON.parse('{"__proto__":"kept"}'),
        });
      }
    });
    const res = await tdb.db.query<{ exact: boolean; context: string }>(
      `SELECT occurred_at = ($1::jsonb ->> (substr(event_id, 5)::int))::timestamptz AS exact,
              context::text AS context
       FROM audit_events ORDER BY event_id`,
      [JSON.stringify(bounds)],
    );
    expect(res.rows).toEqual(bounds.map(() => ({ exact: true, context: '{"__proto__": "kept"}' })));
  });

  test("a failing append rolls back the business write of the same transaction", async () => {
    await withTenantDbTransaction(tdb.db, TENANT_A, (tx) =>
      appendAuditEvent(tx, eventInput("evt_taken", "2026-11-17T09:00:00Z")),
    );
    await expect(
      withTenantDbTransaction(tdb.db, TENANT_A, async (tx) => {
        await tx.query("INSERT INTO fixture_requests (tenant_id, id) VALUES ($1, 'req_0001')", [
          TENANT_A,
        ]);
        await appendAuditEvent(tx, eventInput("evt_taken", "2026-11-17T10:00:00Z"));
      }),
    ).rejects.toThrow(/duplicate key|unique/);
    expect(await ownerCount("fixture_requests")).toBe(0);
    expect(await ownerCount("audit_events")).toBe(1);
  });

  test("outside a tenant context it throws MissingTenantContextError", async () => {
    const spy = spyOn(null);
    await expect(
      appendAuditEvent(spy.executor, eventInput("evt_1", "2026-11-17T10:00:00Z")),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
    expect(spy.statements).toEqual([]);
  });

  test("an invalid event throws before any SQL", async () => {
    const spy = spyOn(tdb.db);
    await expect(
      withTenantDbTransaction(tdb.db, TENANT_A, () =>
        appendAuditEvent(spy.executor, eventInput("", "2026-11-17T10:00:00Z")),
      ),
    ).rejects.toBeInstanceOf(InvalidAuditEventError);
    expect(spy.statements).toEqual([]);
    expect(await ownerCount("audit_events")).toBe(0);
  });
});

describe("recordAuditEventBestEffort (comfort mode)", () => {
  test("a storage failure is absorbed and reported exactly once", async () => {
    const spy = spyOn(tdb.db, /INSERT INTO audit_events/);
    const failures: AuditStoreFailure[] = [];
    const event = await recordAuditEventBestEffort(
      spy.executor,
      TENANT_A,
      eventInput("evt_1", "2026-11-17T10:00:00Z"),
      (failure) => {
        failures.push(failure);
      },
    );
    expect(event).toEqual({
      id: "evt_1",
      action: "request.transition",
      actorId: "usr_0001",
      outcome: "success",
      severity: "info",
      context: {},
      occurredAt: "2026-11-17T10:00:00Z",
    });
    expect(failures).toEqual([{ action: "request.transition", errorName: "StorageDownError" }]);
    expect(await ownerCount("audit_events")).toBe(0);
    // The failed transaction was closed: the session is usable again.
    expect(spy.statements.at(-1)).toBe("ROLLBACK");
  });

  test("a database refusal is absorbed and reported too", async () => {
    await seed(TENANT_A, "evt_taken");
    const failures: AuditStoreFailure[] = [];
    await recordAuditEventBestEffort(
      tdb.db,
      TENANT_A,
      eventInput("evt_taken", "2026-11-17T10:00:00Z"),
      (failure) => {
        failures.push(failure);
      },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.action).toBe("request.transition");
    expect(await ownerCount("audit_events")).toBe(1);
  });

  test("an invalid event rejects, without SQL and without calling onFailure", async () => {
    const spy = spyOn(tdb.db);
    let reported = 0;
    await expect(
      recordAuditEventBestEffort(
        spy.executor,
        TENANT_A,
        { ...eventInput("evt_1", "2026-11-17T10:00:00Z"), action: "" },
        () => {
          reported += 1;
        },
      ),
    ).rejects.toBeInstanceOf(InvalidAuditEventError);
    expect(reported).toBe(0);
    expect(spy.statements).toEqual([]);
  });

  test("an onFailure that throws does not prevent the call from resolving", async () => {
    const spy = spyOn(tdb.db, /INSERT INTO audit_events/);
    let reported = 0;
    const event = await recordAuditEventBestEffort(
      spy.executor,
      TENANT_A,
      eventInput("evt_1", "2026-11-17T10:00:00Z"),
      () => {
        reported += 1;
        throw new Error("reporting is down as well");
      },
    );
    expect(event.id).toBe("evt_1");
    expect(reported).toBe(1);
  });

  test("inside an open tenant transaction it is refused before any SQL", async () => {
    // The probe: a comfort call made from A's operation would run its own
    // BEGIN / SET LOCAL ROLE / COMMIT on the operation's session, commit A's
    // pending business write, drop the role back to the owner and let the
    // rest of the operation run outside the barrier.
    const spy = spyOn(tdb.db);
    let reported = 0;
    await expect(
      withTenantDbTransaction(tdb.db, TENANT_A, async (tx) => {
        await tx.query("INSERT INTO fixture_requests (tenant_id, id) VALUES ($1, 'req_0001')", [
          TENANT_A,
        ]);
        await expect(
          recordAuditEventBestEffort(
            spy.executor,
            TENANT_B,
            eventInput("evt_1", "2026-11-17T10:00:00Z"),
            () => {
              reported += 1;
            },
          ),
        ).rejects.toBeInstanceOf(OpenTenantTransactionError);
        // Still inside A's transaction, still as the application role.
        const who = await tx.query<{ role: string; tenant: string }>(
          "SELECT current_user AS role, current_setting('app.tenant_id', true) AS tenant",
        );
        expect(who.rows).toEqual([{ role: "libre_ai_app", tenant: TENANT_A }]);
        throw new StorageDownError();
      }),
    ).rejects.toBeInstanceOf(StorageDownError);
    expect(spy.statements).toEqual([]);
    expect(reported).toBe(0);
    // A's business write was never committed by the comfort call.
    expect(await ownerCount("fixture_requests")).toBe(0);
    expect(await ownerCount("audit_events")).toBe(0);
  });

  test("an asynchronous onFailure that rejects is absorbed, not left unhandled", async () => {
    const spy = spyOn(tdb.db, /INSERT INTO audit_events/);
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      let reported = 0;
      const event = await recordAuditEventBestEffort(
        spy.executor,
        TENANT_A,
        eventInput("evt_1", "2026-11-17T10:00:00Z"),
        async () => {
          reported += 1;
          throw new Error("asynchronous reporting is down");
        },
      );
      // Let the rejected promise reach the end of the job queue.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(event.id).toBe("evt_1");
      expect(reported).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  test("two successful calls leave two lines, in order, for the given tenant only", async () => {
    let reported = 0;
    const onFailure = (): void => {
      reported += 1;
    };
    await recordAuditEventBestEffort(
      tdb.db,
      TENANT_A,
      eventInput("evt_2", "2026-11-17T11:00:00Z"),
      onFailure,
    );
    await recordAuditEventBestEffort(
      tdb.db,
      TENANT_A,
      eventInput("evt_1", "2026-11-17T10:00:00Z"),
      onFailure,
    );
    expect(reported).toBe(0);
    expect(await ownerCount("audit_events")).toBe(2);
    expect(await visibleEventIds(TENANT_A)).toEqual(["evt_1", "evt_2"]);
    expect(await visibleEventIds(TENANT_B)).toEqual([]);
  });
});
