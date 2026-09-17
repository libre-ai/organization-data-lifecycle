import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@libre-ai/testing";
import { buildCompletedDeletionReceipt } from "../deletion-receipt";
import { replayDeletionsOnRestore } from "../restore-replay";
import { BelowMinimumRetentionError } from "../retention-bounds";
import { requireTenantContext } from "../tenant-context";
import { MalformedTenantIdError } from "../tenant-id";
import {
  getDeletionReceipt,
  listCompletedSubjectDigests,
  persistDeletionReceipt,
} from "./deletion-receipt-store";
import { selectExpiredRowIds, UnsafeTableNameError } from "./expired-selection-query";
import { getRetentionRule, upsertRetentionRule } from "./retention-rules-store";
import { clearPooledSession, withTenantDbTransaction } from "./tenant-transaction";

/**
 * WP-G2-D01 adapters: the bridge between the application layer (defense in
 * depth) and the PostgreSQL barrier (mandatory enforcement). Every adapter
 * operation runs under BOTH contexts at once — AsyncLocalStorage on the
 * application side, SET LOCAL ROLE + app.tenant_id on the database side.
 */

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const TENANT_A = "ten_aaaaaaaaaaaaaaaa";
const TENANT_B = "ten_bbbbbbbbbbbbbbbb";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

const RADAR_NORMALIZED = {
  id: "radar-normalized",
  mode: "fixed",
  defaultRetention: "P90D",
  configurable: { minimum: "P7D", maximum: "P365D" },
};

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase();
  await tdb.applyMigrations(MIGRATIONS_DIR);
  // Product-style fixture table, provisioned like any owner table would be.
  await tdb.db.exec(`
    CREATE TABLE fixture_documents (
      tenant_id text NOT NULL CHECK (tenant_id ~ '^ten_[a-z0-9]{16,64}$'),
      id text NOT NULL,
      created_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, id)
    );
    ALTER TABLE fixture_documents ENABLE ROW LEVEL SECURITY;
    ALTER TABLE fixture_documents FORCE ROW LEVEL SECURITY;
    CREATE POLICY fixture_documents_tenant_isolation ON fixture_documents
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON fixture_documents TO libre_ai_app;
    INSERT INTO fixture_documents (tenant_id, id, created_at) VALUES
      ('${TENANT_A}', 'doc_old', '2026-01-01T00:00:00Z'),
      ('${TENANT_A}', 'doc_fresh', '2026-07-15T00:00:00Z'),
      ('${TENANT_B}', 'doc_b_old', '2026-01-01T00:00:00Z');
  `);
});

afterAll(async () => {
  await tdb.close();
});

describe("withTenantDbTransaction", () => {
  test("establishes both contexts: application ALS and database GUC agree", async () => {
    await withTenantDbTransaction(tdb.db, TENANT_A, async (tx) => {
      expect(requireTenantContext()).toBe(TENANT_A);
      const res = await tx.query<{ v: string }>(
        "SELECT current_setting('app.tenant_id', true) AS v",
      );
      expect(res.rows[0]?.v).toBe(TENANT_A);
    });
  });

  test("rejects a malformed tenant id before touching the database", async () => {
    await expect(withTenantDbTransaction(tdb.db, "ten_UPPER", async () => {})).rejects.toThrow(
      MalformedTenantIdError,
    );
  });

  test("rolls back on throw and clears the application context", async () => {
    await expect(
      withTenantDbTransaction(tdb.db, TENANT_A, async (tx) => {
        await tx.query(
          `INSERT INTO retention_rules (tenant_id, rule_id, retention, updated_by, updated_at)
           VALUES ($1, 'rolled-back', 'P30D', 'usr_t', '2026-07-20T00:00:00Z')`,
          [TENANT_A],
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(() => requireTenantContext()).toThrow();
    await withTenantDbTransaction(tdb.db, TENANT_A, async (tx) => {
      const res = await tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM retention_rules WHERE rule_id = 'rolled-back'",
      );
      expect(res.rows[0]?.n).toBe(0);
    });
  });
});

describe("retention-rules-store (application validation composed above the barrier)", () => {
  test("a value below the contract minimum is refused and nothing is written", async () => {
    await expect(
      withTenantDbTransaction(tdb.db, TENANT_A, (tx) =>
        upsertRetentionRule(tx, {
          rule: RADAR_NORMALIZED,
          requested: "P2D",
          updatedBy: "usr_t",
          updatedAt: "2026-07-20T00:00:00Z",
        }),
      ),
    ).rejects.toThrow(BelowMinimumRetentionError);
    await withTenantDbTransaction(tdb.db, TENANT_A, async (tx) => {
      expect(await getRetentionRule(tx, "radar-normalized")).toBeNull();
    });
  });

  test("a valid value upserts under the current tenant and reads back", async () => {
    await withTenantDbTransaction(tdb.db, TENANT_A, async (tx) => {
      await upsertRetentionRule(tx, {
        rule: RADAR_NORMALIZED,
        requested: "P30D",
        updatedBy: "usr_t",
        updatedAt: "2026-07-20T00:00:00Z",
      });
      const rule = await getRetentionRule(tx, "radar-normalized");
      expect(rule?.retention).toBe("P30D");
      expect(rule?.tenantId).toBe(TENANT_A);
    });
  });

  test("another tenant does not see the rule", async () => {
    await withTenantDbTransaction(tdb.db, TENANT_B, async (tx) => {
      expect(await getRetentionRule(tx, "radar-normalized")).toBeNull();
    });
  });
});

describe("deletion-receipt-store (append-only evidence)", () => {
  const receipt = buildCompletedDeletionReceipt({
    id: "rcp_int1",
    tenantId: TENANT_A,
    owner: "radar",
    subjectDigests: [DIGEST_A, DIGEST_B],
    requestedBy: "usr_t",
    requestedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:00:05.000Z",
    stores: [
      { store: "postgresql", outcome: "deleted" },
      { store: "redis", outcome: "deleted" },
      { store: "cellar", outcome: "not-applicable", reasonCode: "deletion.no-blobs" },
    ],
  });

  test("persists a built receipt and reads it back intact", async () => {
    await withTenantDbTransaction(tdb.db, TENANT_A, async (tx) => {
      await persistDeletionReceipt(tx, receipt);
      const loaded = await getDeletionReceipt(tx, "rcp_int1");
      expect(loaded).toEqual(receipt);
    });
  });

  test("a receipt whose tenant differs from the active context is denied by the barrier", async () => {
    const foreign = buildCompletedDeletionReceipt({
      id: "rcp_foreign",
      tenantId: TENANT_B,
      owner: "radar",
      subjectDigests: [DIGEST_A],
      requestedBy: "usr_t",
      requestedAt: "2026-07-20T00:00:00.000Z",
      completedAt: "2026-07-20T00:00:05.000Z",
      stores: [{ store: "postgresql", outcome: "deleted" }],
    });
    await expect(
      withTenantDbTransaction(tdb.db, TENANT_A, (tx) => persistDeletionReceipt(tx, foreign)),
    ).rejects.toThrow(/row-level security/);
  });

  test("receipts cannot be rewritten or erased by the application role", async () => {
    // One transaction per verb: a denied statement aborts its transaction,
    // so the assertion must observe the whole transaction's rejection.
    await expect(
      withTenantDbTransaction(tdb.db, TENANT_A, (tx) =>
        tx.query(
          "UPDATE deletion_receipts SET receipt = '{}'::jsonb WHERE receipt_id = 'rcp_int1'",
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenantDbTransaction(tdb.db, TENANT_A, (tx) =>
        tx.query("DELETE FROM deletion_receipts WHERE receipt_id = 'rcp_int1'"),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  test("restore replay over persisted receipts does not resurrect deleted subjects", async () => {
    const survivors = await withTenantDbTransaction(tdb.db, TENANT_A, async (tx) => {
      const persisted = await listCompletedSubjectDigests(tx);
      return replayDeletionsOnRestore([DIGEST_A, "c".repeat(64)], persisted);
    });
    expect(survivors).toEqual(["c".repeat(64)]);
  });
});

describe("expired-selection query (controlled clock)", () => {
  test("selects exactly the rows whose age reached the window, tenant-scoped", async () => {
    const ids = await withTenantDbTransaction(tdb.db, TENANT_A, (tx) =>
      selectExpiredRowIds(tx, "fixture_documents", {
        now: "2026-07-20T00:00:00Z",
        retentionDays: 90,
      }),
    );
    expect(ids).toEqual(["doc_old"]);
  });

  test("a shorter retention schedules already-expired records immediately", async () => {
    const ids = await withTenantDbTransaction(tdb.db, TENANT_A, (tx) =>
      selectExpiredRowIds(tx, "fixture_documents", {
        now: "2026-07-20T00:00:00Z",
        retentionDays: 1,
      }),
    );
    expect(ids.sort()).toEqual(["doc_fresh", "doc_old"]);
  });

  test("never reaches another tenant's rows even with a permissive window", async () => {
    const ids = await withTenantDbTransaction(tdb.db, TENANT_B, (tx) =>
      selectExpiredRowIds(tx, "fixture_documents", {
        now: "2026-07-20T00:00:00Z",
        retentionDays: 1,
      }),
    );
    expect(ids).toEqual(["doc_b_old"]);
  });

  test("rejects an unsafe table identifier before any SQL is sent", async () => {
    await expect(
      withTenantDbTransaction(tdb.db, TENANT_A, (tx) =>
        selectExpiredRowIds(tx, 'fixture_documents"; DROP TABLE retention_rules; --', {
          now: "2026-07-20T00:00:00Z",
          retentionDays: 1,
        }),
      ),
    ).rejects.toThrow(UnsafeTableNameError);
  });
});

describe("pooled-session clearing (adapter side)", () => {
  test("a session-level tenant GUC planted outside SET LOCAL is purged before reuse", async () => {
    // Attack shape: some caller sets app.tenant_id at SESSION level, which
    // would survive transaction end and leak scope into the next checkout.
    await tdb.db.exec(`SET app.tenant_id = '${TENANT_A}'`);
    await clearPooledSession(tdb.db);
    const res = await tdb.db.query<{ v: string | null }>(
      "SELECT current_setting('app.tenant_id', true) AS v",
    );
    expect(res.rows[0]?.v ?? "").toBe("");
  });
});
