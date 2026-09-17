import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@libre-ai/testing";
import { assertWithinBackupCeiling } from "../backup-ceiling";
import { CachePurgeFailedError, executeActiveDeletion } from "./active-deletion";
import { InMemoryBlobStore } from "./blob-store-port";
import { getDeletionReceipt } from "./deletion-receipt-store";
import { InMemoryProjectionCache, MissingTtlError } from "./projection-cache-port";
import { withTenantDbTransaction } from "./tenant-transaction";

/**
 * WP-G2-D01 acceptance criterion 2, end to end: an explicit active deletion
 * removes the rows, purges cache projections (with bounded retry — a cache
 * failure can never restore access), enqueues content-addressed blob
 * deletion only, and emits a persisted, contract-valid DeletionReceipt
 * bounded by the 35-day backup ceiling.
 */

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const TENANT_A = "ten_aaaaaaaaaaaaaaaa";
const DIGEST_1 = "1".repeat(64);
const DIGEST_2 = "2".repeat(64);

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase();
  await tdb.applyMigrations(MIGRATIONS_DIR);
  await tdb.db.exec(`
    CREATE TABLE fixture_notes (
      tenant_id text NOT NULL CHECK (tenant_id ~ '^ten_[a-z0-9]{16,64}$'),
      digest text NOT NULL,
      body text NOT NULL,
      PRIMARY KEY (tenant_id, digest)
    );
    ALTER TABLE fixture_notes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE fixture_notes FORCE ROW LEVEL SECURITY;
    CREATE POLICY fixture_notes_tenant_isolation ON fixture_notes
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON fixture_notes TO libre_ai_app;
  `);
});

afterAll(async () => {
  await tdb.close();
});

async function seedNotes(): Promise<void> {
  await tdb.db.query(
    `INSERT INTO fixture_notes (tenant_id, digest, body) VALUES
     ($1, $2, 'secret-1'), ($1, $3, 'secret-2')
     ON CONFLICT (tenant_id, digest) DO NOTHING`,
    [TENANT_A, DIGEST_1, DIGEST_2],
  );
}

function deletionRequest(id: string) {
  return {
    id,
    tenantId: TENANT_A,
    owner: "radar",
    subjectDigests: [DIGEST_1, DIGEST_2],
    requestedBy: "usr_t",
    requestedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:00:05.000Z",
    deleteActiveRows: async (tx: {
      query: (sql: string, params?: unknown[]) => Promise<unknown>;
    }) => {
      await tx.query("DELETE FROM fixture_notes WHERE digest = ANY($1)", [[DIGEST_1, DIGEST_2]]);
    },
  };
}

describe("executeActiveDeletion", () => {
  test("deletes rows, purges cache, enqueues content-addressed blobs, persists a valid receipt", async () => {
    await seedNotes();
    const cache = new InMemoryProjectionCache();
    await cache.set(`${TENANT_A}:note:${DIGEST_1}`, "projection", 60);
    const blobs = new InMemoryBlobStore();
    await blobs.put(DIGEST_1, new Uint8Array([1]), { owner: "radar", tenantId: TENANT_A });

    const receipt = await executeActiveDeletion(tdb.db, cache, blobs, deletionRequest("rcp_e2e"));

    expect(receipt.status).toBe("complete");
    expect(() =>
      assertWithinBackupCeiling(receipt.completedAt, receipt.backupExpiresAt),
    ).not.toThrow();
    expect(receipt.stores.map((s) => s.store).sort()).toEqual(["cellar", "postgresql", "redis"]);
    expect(cache.get(`${TENANT_A}:note:${DIGEST_1}`)).toBeNull();
    expect(blobs.pendingDeletions()).toEqual([DIGEST_1]);

    await withTenantDbTransaction(tdb.db, TENANT_A, async (tx) => {
      const rows = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM fixture_notes");
      expect(rows.rows[0]?.n).toBe(0);
      expect(await getDeletionReceipt(tx, "rcp_e2e")).toEqual(receipt);
    });
  });

  test("a transient cache failure is retried and cannot restore access", async () => {
    await seedNotes();
    const cache = new InMemoryProjectionCache();
    cache.failNextPurges(1);
    const blobs = new InMemoryBlobStore();

    const receipt = await executeActiveDeletion(tdb.db, cache, blobs, deletionRequest("rcp_retry"));
    expect(receipt.stores.find((s) => s.store === "redis")?.outcome).toBe("deleted");
    expect(cache.purgeAttempts).toBe(2);
  });

  test("a persistent cache failure aborts before any row is deleted (retryable, fail closed)", async () => {
    await seedNotes();
    const cache = new InMemoryProjectionCache();
    cache.failNextPurges(10);
    const blobs = new InMemoryBlobStore();

    await expect(
      executeActiveDeletion(tdb.db, cache, blobs, deletionRequest("rcp_fail")),
    ).rejects.toThrow(CachePurgeFailedError);
    await withTenantDbTransaction(tdb.db, TENANT_A, async (tx) => {
      const rows = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM fixture_notes");
      expect(rows.rows[0]?.n).toBe(2);
      expect(await getDeletionReceipt(tx, "rcp_fail")).toBeNull();
    });
  });

  test("an append-only owner can qualify the postgresql outcome with a reason code", async () => {
    // Append-only stores (e.g. sessions' event log) erase by removing
    // logical access in the accepted transaction; the receipt stays
    // outcome=deleted (DATA-LIFECYCLE §Explicit deletion item 6) but carries
    // the qualifier so an auditor sees compaction is deferred.
    await seedNotes();
    const receipt = await executeActiveDeletion(
      tdb.db,
      new InMemoryProjectionCache(),
      new InMemoryBlobStore(),
      {
        ...deletionRequest("rcp_reason"),
        postgresqlReasonCode: "deletion.deferred-compaction",
      },
    );
    const postgresql = receipt.stores.find((s) => s.store === "postgresql");
    expect(postgresql?.outcome).toBe("deleted");
    expect(postgresql?.reasonCode).toBe("deletion.deferred-compaction");
  });

  test("a malformed postgresql reason code is refused BEFORE any mutation", async () => {
    // Fail-closed at the entry: no cache purge, no blob enqueue (an external
    // effect a SQL rollback cannot undo), no row deleted, no receipt — and
    // the error never echoes the offending value (it may carry PII).
    await seedNotes();
    const cache = new InMemoryProjectionCache();
    await cache.set(`${TENANT_A}:note:${DIGEST_1}`, "projection", 60);
    const blobs = new InMemoryBlobStore();
    await blobs.put(DIGEST_1, new Uint8Array([1]), { owner: "radar", tenantId: TENANT_A });

    const offending = "free text with PII";
    let caught: unknown;
    try {
      await executeActiveDeletion(tdb.db, cache, blobs, {
        ...deletionRequest("rcp_badreason"),
        postgresqlReasonCode: offending,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(offending);
    expect(cache.get(`${TENANT_A}:note:${DIGEST_1}`)).toBe("projection");
    expect(blobs.pendingDeletions()).toEqual([]);
    await withTenantDbTransaction(tdb.db, TENANT_A, async (tx) => {
      const rows = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM fixture_notes");
      expect(rows.rows[0]?.n).toBe(2);
      expect(await getDeletionReceipt(tx, "rcp_badreason")).toBeNull();
    });
  });

  test("no blobs for the digests yields a cellar not-applicable outcome", async () => {
    await seedNotes();
    const cache = new InMemoryProjectionCache();
    const blobs = new InMemoryBlobStore();
    const receipt = await executeActiveDeletion(
      tdb.db,
      cache,
      blobs,
      deletionRequest("rcp_noblob"),
    );
    const cellar = receipt.stores.find((s) => s.store === "cellar");
    expect(cellar?.outcome).toBe("not-applicable");
    expect(cellar?.reasonCode).toBe("deletion.no-blobs");
  });
});

describe("projection-cache port contract", () => {
  test("a TTL is mandatory on every entry (never an authority, always bounded)", async () => {
    const cache = new InMemoryProjectionCache();
    await expect(cache.set("k", "v", 0)).rejects.toThrow(MissingTtlError);
  });
});
