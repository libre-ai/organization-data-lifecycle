import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@libre-ai/testing";

/**
 * WP-G2-D01 acceptance criterion 1, DB side: the PostgreSQL barrier itself —
 * RLS policies, FORCE, CHECK constraints, least-privilege grants — denies
 * every cross-tenant or missing-context access, in raw SQL, without any
 * application-layer helper. This is the mandatory layer the independent
 * review identified; the helpers in ../ are defense in depth above it.
 */

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const TENANT_A = "ten_aaaaaaaaaaaaaaaa";
const TENANT_B = "ten_bbbbbbbbbbbbbbbb";

let tdb: TestDatabase;

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

beforeAll(async () => {
  tdb = await createTestDatabase();
  await tdb.applyMigrations(MIGRATIONS_DIR);
  // Seed as the migration owner (superuser, bypasses RLS but not CHECKs).
  await tdb.db.query(
    `INSERT INTO retention_rules (tenant_id, rule_id, retention, updated_by, updated_at) VALUES
     ($1, 'radar-normalized', 'P90D', 'usr_seed', '2026-07-20T00:00:00Z'),
     ($1, 'browser-session', 'P1D', 'usr_seed', '2026-07-20T00:00:00Z'),
     ($2, 'radar-normalized', 'P30D', 'usr_seed', '2026-07-20T00:00:00Z')`,
    [TENANT_A, TENANT_B],
  );
});

afterAll(async () => {
  await tdb.close();
});

describe("application role posture", () => {
  test("libre_ai_app is neither superuser nor BYPASSRLS", async () => {
    const res = await tdb.db.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'libre_ai_app'",
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.rolsuper).toBe(false);
    expect(res.rows[0]?.rolbypassrls).toBe(false);
  });

  test("RLS is enabled AND forced on both platform tables", async () => {
    const res = await tdb.db.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('retention_rules', 'deletion_receipts') ORDER BY relname`,
    );
    expect(res.rows).toHaveLength(2);
    for (const row of res.rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });
});

describe("two-tenant isolation (raw SQL, no helpers)", () => {
  test("tenant A sees only its own retention rules", async () => {
    const rows = await asTenant(TENANT_A, async () => {
      const res = await tdb.db.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM retention_rules",
      );
      return res.rows;
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tenant_id === TENANT_A)).toBe(true);
  });

  test("tenant B sees only its own retention rules", async () => {
    const rows = await asTenant(TENANT_B, async () => {
      const res = await tdb.db.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM retention_rules",
      );
      return res.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(TENANT_B);
  });

  test("cross-tenant INSERT is denied by WITH CHECK", async () => {
    await asTenant(TENANT_A, async () => {
      await expect(
        tdb.db.query(
          `INSERT INTO retention_rules (tenant_id, rule_id, retention, updated_by, updated_at)
           VALUES ($1, 'radar-quarantine', 'P7D', 'usr_evil', '2026-07-20T00:00:00Z')`,
          [TENANT_B],
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  test("cross-tenant UPDATE reaches zero rows", async () => {
    const affected = await asTenant(TENANT_A, async () => {
      const res = await tdb.db.query(
        "UPDATE retention_rules SET retention = 'P7D' WHERE tenant_id = $1",
        [TENANT_B],
      );
      return res.affectedRows ?? 0;
    });
    expect(affected).toBe(0);
  });

  test("cross-tenant DELETE reaches zero rows", async () => {
    const affected = await asTenant(TENANT_A, async () => {
      const res = await tdb.db.query("DELETE FROM retention_rules WHERE tenant_id = $1", [
        TENANT_B,
      ]);
      return res.affectedRows ?? 0;
    });
    expect(affected).toBe(0);
  });
});

describe("missing tenant context (fail closed)", () => {
  test("SELECT yields zero rows without app.tenant_id", async () => {
    const count = await asTenant(null, async () => {
      const res = await tdb.db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM retention_rules",
      );
      return res.rows[0]?.n;
    });
    expect(count).toBe(0);
  });

  test("INSERT is denied without app.tenant_id", async () => {
    await asTenant(null, async () => {
      await expect(
        tdb.db.query(
          `INSERT INTO retention_rules (tenant_id, rule_id, retention, updated_by, updated_at)
           VALUES ($1, 'radar-quarantine', 'P7D', 'usr_evil', '2026-07-20T00:00:00Z')`,
          [TENANT_A],
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });
});

describe("structural CHECKs hold even for RLS-bypassing roles", () => {
  test("the public service tenant cannot own a private platform row", async () => {
    await expect(
      tdb.db.query(
        `INSERT INTO retention_rules (tenant_id, rule_id, retention, updated_by, updated_at)
         VALUES ('public', 'radar-normalized', 'P90D', 'usr_seed', '2026-07-20T00:00:00Z')`,
      ),
    ).rejects.toThrow(/check constraint|violates/);
  });

  test("a malformed tenant id is rejected structurally", async () => {
    await expect(
      tdb.db.query(
        `INSERT INTO retention_rules (tenant_id, rule_id, retention, updated_by, updated_at)
         VALUES ('ten_UPPER', 'radar-normalized', 'P90D', 'usr_seed', '2026-07-20T00:00:00Z')`,
      ),
    ).rejects.toThrow(/check constraint|violates/);
  });

  test("a deletion receipt whose backup expiry exceeds completed_at + 35 days is refused", async () => {
    await expect(
      tdb.db.query(
        `INSERT INTO deletion_receipts (tenant_id, receipt_id, receipt, completed_at, backup_expires_at)
         VALUES ($1, 'rcp_over', '{}'::jsonb, '2026-07-20T00:00:00Z', '2026-08-25T00:00:01Z')`,
        [TENANT_A],
      ),
    ).rejects.toThrow(/check constraint|violates/);
  });

  test("a deletion receipt at exactly the 35-day ceiling is accepted", async () => {
    await tdb.db.query(
      `INSERT INTO deletion_receipts (tenant_id, receipt_id, receipt, completed_at, backup_expires_at)
       VALUES ($1, 'rcp_edge', '{}'::jsonb, '2026-07-20T00:00:00Z', '2026-08-24T00:00:00Z')`,
      [TENANT_A],
    );
    const res = await tdb.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM deletion_receipts WHERE receipt_id = 'rcp_edge'",
    );
    expect(res.rows[0]?.n).toBe(1);
  });
});

describe("least-privilege grants", () => {
  test("the app role cannot TRUNCATE a platform table", async () => {
    await asTenant(TENANT_A, async () => {
      await expect(tdb.db.exec("TRUNCATE retention_rules")).rejects.toThrow(/permission denied/);
    });
  });

  test("the app role cannot disable row security on a platform table", async () => {
    await asTenant(TENANT_A, async () => {
      await expect(
        tdb.db.exec("ALTER TABLE retention_rules DISABLE ROW LEVEL SECURITY"),
      ).rejects.toThrow(/must be owner|permission denied/);
    });
  });
});
