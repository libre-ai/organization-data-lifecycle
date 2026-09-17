import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@libre-ai/testing";
import type { SqlExecutor } from "./adapters/executor";
import { upsertRetentionRule } from "./adapters/retention-rules-store";
import { withTenantRetentionTransaction } from "./adapters/retention-transaction";
import { withTenantDbTransaction } from "./adapters/tenant-transaction";
import {
  type CompactionSpec,
  RetentionWindowUnresolvedError,
  runRetentionSweep,
} from "./retention-sweep";
import { requireTenantContext } from "./tenant-context";
import { MalformedTenantIdError } from "./tenant-id";

/**
 * The GENERIC half of the retention design §6 (retention execution +
 * physical compaction, 2026-07-24): the dedicated role, the retention barrier,
 * and the spec-driven sweep orchestrator. It owns zero Sessions knowledge — a
 * MINIMAL in-test fixture spec over a `retention_probe` table stands in for
 * the product; the Sessions compaction spec is the next task's job.
 */

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");
const TENANT_A = "ten_aaaaaaaaaaaaaaaa";
const TENANT_B = "ten_bbbbbbbbbbbbbbbb";
const NOW = "2026-07-24T00:00:00Z";
// A real contract rule (contracts/data/retention.v1.json): default P90D,
// configurable P7D..P365D. Lets the sweep exercise the contract-default path.
const SESSIONS_CONTENT = "sessions-content";
const SESSIONS_CONTENT_RULE = {
  id: SESSIONS_CONTENT,
  mode: "fixed",
  defaultRetention: "P90D",
  configurable: { minimum: "P7D", maximum: "P365D" },
};

let tdb: TestDatabase;

/**
 * Fixture spec halves. `probeSelect` runs under the APP barrier (read-only,
 * app role has SELECT); `probeCompact` runs under the RETENTION barrier
 * (retention role has SELECT, DELETE) and RE-CHECKS the predicate inside its
 * own transaction before deleting — the advisory-selection/authoritative-guard
 * split the orchestrator relies on.
 */
const probeSelect = async (
  tx: SqlExecutor,
  _tenantId: string,
  now: string,
  retentionDays: number,
): Promise<readonly string[]> => {
  const res = await tx.query<{ id: string }>(
    `SELECT id FROM retention_probe
     WHERE recorded_at + make_interval(days => $1) <= $2::timestamptz
     ORDER BY id`,
    [retentionDays, now],
  );
  return res.rows.map((row) => row.id);
};

const probeCompact = async (
  tx: SqlExecutor,
  _tenantId: string,
  unitId: string,
  now: string,
  retentionDays: number,
): Promise<{ deleted: boolean; eventsDeleted: number; compactedReceiptIds: readonly string[] }> => {
  const still = await tx.query<{ event_weight: number; subject_receipt: string | null }>(
    `SELECT event_weight, subject_receipt FROM retention_probe
     WHERE id = $1 AND recorded_at + make_interval(days => $2) <= $3::timestamptz`,
    [unitId, retentionDays, now],
  );
  const row = still.rows[0];
  if (row === undefined) {
    return { deleted: false, eventsDeleted: 0, compactedReceiptIds: [] };
  }
  await tx.query("DELETE FROM retention_probe WHERE id = $1", [unitId]);
  return {
    deleted: true,
    eventsDeleted: row.event_weight,
    compactedReceiptIds: row.subject_receipt === null ? [] : [row.subject_receipt],
  };
};

function makeProbeSpec(overrides: Partial<CompactionSpec> = {}): CompactionSpec {
  return {
    owner: "sessions",
    ruleId: SESSIONS_CONTENT,
    selectExpiredUnits: probeSelect,
    compactUnit: probeCompact,
    holds: async () => [],
    ...overrides,
  };
}

async function probeCount(tenantId: string): Promise<number> {
  const res = await tdb.db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM retention_probe WHERE tenant_id = $1",
    [tenantId],
  );
  return res.rows[0]?.n ?? -1;
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  await tdb.applyMigrations(MIGRATIONS_DIR);
  // Product-shaped fixture: app reads for selection, retention deletes for
  // compaction — the exact grant split the design mandates. The app role gets
  // NO write grant, so this table doubles as the app-floor regression surface.
  await tdb.db.exec(`
    CREATE TABLE retention_probe (
      tenant_id text NOT NULL CHECK (tenant_id ~ '^ten_[a-z0-9]{16,64}$'),
      id text NOT NULL,
      recorded_at timestamptz NOT NULL,
      event_weight integer NOT NULL DEFAULT 1,
      subject_receipt text,
      PRIMARY KEY (tenant_id, id)
    );
    ALTER TABLE retention_probe ENABLE ROW LEVEL SECURITY;
    ALTER TABLE retention_probe FORCE ROW LEVEL SECURITY;
    CREATE POLICY retention_probe_tenant_isolation ON retention_probe
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
    GRANT SELECT ON retention_probe TO libre_ai_app;
    GRANT SELECT, DELETE ON retention_probe TO libre_ai_retention;
  `);
});

afterAll(async () => {
  await tdb.close();
});

beforeEach(async () => {
  // Superuser reset (bypasses RLS): every test starts from the same fixture.
  await tdb.db.exec("DELETE FROM retention_probe");
  await tdb.db.exec("DELETE FROM retention_rules");
  await tdb.db.exec(`
    INSERT INTO retention_probe (tenant_id, id, recorded_at, event_weight, subject_receipt) VALUES
      ('${TENANT_A}', 'probe_old',   '2026-01-01T00:00:00Z', 3, 'rcp_old'),
      ('${TENANT_A}', 'probe_mid',   '2026-06-09T00:00:00Z', 5, NULL),
      ('${TENANT_A}', 'probe_fresh', '2026-07-20T00:00:00Z', 1, NULL),
      ('${TENANT_B}', 'probe_b_old', '2026-01-01T00:00:00Z', 9, 'rcp_b');
  `);
});

describe("design §6.1 — role probe and app-floor regression", () => {
  test("libre_ai_retention is NOLOGIN, NOSUPERUSER, NOBYPASSRLS", async () => {
    const res = await tdb.db.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      "SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'libre_ai_retention'",
    );
    expect(res.rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false });
  });

  test("app floor untouched: UPDATE/DELETE rejected under the app barrier", async () => {
    await expect(
      withTenantDbTransaction(tdb.db, TENANT_A, (tx) =>
        tx.query("DELETE FROM retention_probe WHERE id = 'probe_old'"),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenantDbTransaction(tdb.db, TENANT_A, (tx) =>
        tx.query("UPDATE retention_probe SET event_weight = 0 WHERE id = 'probe_old'"),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("withTenantRetentionTransaction — the retention barrier", () => {
  test("sets the retention role and tenant GUC inside; clears ALS after", async () => {
    await withTenantRetentionTransaction(tdb.db, TENANT_A, async (tx) => {
      const r = await tx.query<{ u: string; role: string; t: string }>(
        "SELECT current_user AS u, current_role AS role, current_setting('app.tenant_id', true) AS t",
      );
      expect(r.rows[0]?.u).toBe("libre_ai_retention");
      expect(r.rows[0]?.role).toBe("libre_ai_retention");
      expect(r.rows[0]?.t).toBe(TENANT_A);
      expect(requireTenantContext()).toBe(TENANT_A);
    });
    expect(() => requireTenantContext()).toThrow();
  });

  test("rejects a malformed tenant id before touching the database", async () => {
    await expect(
      withTenantRetentionTransaction(tdb.db, "ten_UPPER", async () => {}),
    ).rejects.toThrow(MalformedTenantIdError);
  });

  test("ROLLBACK on thrown error undoes the retention deletion", async () => {
    await expect(
      withTenantRetentionTransaction(tdb.db, TENANT_A, async (tx) => {
        await tx.query("DELETE FROM retention_probe WHERE id = 'probe_old'");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await probeCount(TENANT_A)).toBe(3);
  });

  test("FORCE RLS binds the retention role: a delete under one tenant spares another", async () => {
    await withTenantRetentionTransaction(tdb.db, TENANT_A, async (tx) => {
      await tx.query("DELETE FROM retention_probe");
    });
    expect(await probeCount(TENANT_A)).toBe(0);
    expect(await probeCount(TENANT_B)).toBe(1);
  });
});

describe("runRetentionSweep — orchestration", () => {
  test("advisory selection, authoritative re-check: compactUnit deleted:false yields zero deletions", async () => {
    const spec = makeProbeSpec({
      selectExpiredUnits: async () => ["probe_old"],
      compactUnit: async () => ({ deleted: false, eventsDeleted: 0, compactedReceiptIds: [] }),
    });
    const report = await runRetentionSweep(tdb.db, spec, TENANT_A, NOW);
    expect(report.sessionsSelected).toBe(1);
    expect(report.sessionsDeleted).toBe(0);
    expect(report.eventsDeleted).toBe(0);
    expect(report.compactedReceiptIds).toEqual([]);
    // The guard held: the row is untouched.
    expect(await probeCount(TENANT_A)).toBe(3);
  });

  test("fail-closed: a per-unit error aborts the sweep, committed units stay, later units never run", async () => {
    const calls: string[] = [];
    const spec = makeProbeSpec({
      selectExpiredUnits: async () => ["probe_old", "probe_mid", "probe_fresh"],
      compactUnit: async (tx, _t, unitId) => {
        calls.push(unitId);
        if (unitId === "probe_mid") {
          throw new Error("unit_failure");
        }
        await tx.query("DELETE FROM retention_probe WHERE id = $1", [unitId]);
        return { deleted: true, eventsDeleted: 1, compactedReceiptIds: [] };
      },
    });
    await expect(runRetentionSweep(tdb.db, spec, TENANT_A, NOW)).rejects.toThrow(/unit_failure/);
    expect(calls).toEqual(["probe_old", "probe_mid"]); // probe_fresh never reached
    // Unit 1 committed independently; unit 2 rolled back; unit 3 untouched.
    expect(await probeCount(TENANT_A)).toBe(2);
  });

  test("holds block the sweep entirely: zero deletions, selection never runs", async () => {
    let selected = false;
    const spec = makeProbeSpec({
      holds: async () => ["hold_1"],
      selectExpiredUnits: async (...args) => {
        selected = true;
        return probeSelect(...args);
      },
    });
    const report = await runRetentionSweep(tdb.db, spec, TENANT_A, NOW);
    expect(selected).toBe(false);
    expect(report.sessionsSelected).toBe(0);
    expect(report.sessionsDeleted).toBe(0);
    expect(report.eventsDeleted).toBe(0);
    expect(report.compactedReceiptIds).toEqual([]);
    expect(await probeCount(TENANT_A)).toBe(3); // nothing swept
  });

  test("rule resolution: contract default (P90D) applies when no tenant rule is stored", async () => {
    const seen: number[] = [];
    const spec = makeProbeSpec({
      selectExpiredUnits: async (tx, tenantId, now, days) => {
        seen.push(days);
        return probeSelect(tx, tenantId, now, days);
      },
    });
    const report = await runRetentionSweep(tdb.db, spec, TENANT_A, NOW);
    expect(seen).toEqual([90]);
    expect(report.sessionsSelected).toBe(1); // only probe_old is > 90d old
    expect(report.sessionsDeleted).toBe(1);
    expect(report.eventsDeleted).toBe(3);
    expect(report.compactedReceiptIds).toEqual(["rcp_old"]);
    expect(await probeCount(TENANT_A)).toBe(2);
  });

  test("rule resolution: a stored tenant rule (P30D) wins over the contract default", async () => {
    await withTenantDbTransaction(tdb.db, TENANT_A, (tx) =>
      upsertRetentionRule(tx, {
        rule: SESSIONS_CONTENT_RULE,
        requested: "P30D",
        updatedBy: "usr_owner",
        updatedAt: "2026-07-23T00:00:00Z",
      }),
    );
    const seen: number[] = [];
    const spec = makeProbeSpec({
      selectExpiredUnits: async (tx, tenantId, now, days) => {
        seen.push(days);
        return probeSelect(tx, tenantId, now, days);
      },
    });
    const report = await runRetentionSweep(tdb.db, spec, TENANT_A, NOW);
    expect(seen).toEqual([30]);
    expect(report.sessionsSelected).toBe(2); // probe_old (204d) + probe_mid (45d)
    expect(report.sessionsDeleted).toBe(2);
    expect(report.eventsDeleted).toBe(8); // 3 + 5
    expect(report.compactedReceiptIds).toEqual(["rcp_old"]); // probe_mid carries no receipt
    expect(await probeCount(TENANT_A)).toBe(1); // probe_fresh survives
  });

  test("rule resolution fails closed for a rule with no window and no stored value", async () => {
    const spec = makeProbeSpec({ ruleId: "no-such-rule-xyz" });
    await expect(runRetentionSweep(tdb.db, spec, TENANT_A, NOW)).rejects.toThrow(
      RetentionWindowUnresolvedError,
    );
  });

  test("report opacity: exactly the specified aggregate/opaque keys, no content", async () => {
    const report = await runRetentionSweep(tdb.db, makeProbeSpec(), TENANT_A, NOW);
    expect(Object.keys(report).sort()).toEqual(
      [
        "compactedReceiptIds",
        "eventsDeleted",
        "owner",
        "ruleId",
        "sessionsDeleted",
        "sessionsSelected",
        "sweptAt",
        "tenantId",
      ].sort(),
    );
    expect(report.owner).toBe("sessions");
    expect(report.tenantId).toBe(TENANT_A);
    expect(report.ruleId).toBe(SESSIONS_CONTENT);
    expect(report.sweptAt).toBe(NOW);
  });
});
