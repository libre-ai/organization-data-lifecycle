import { describe, expect, test } from "bun:test";

import { MissingTenantContextError, runInTenantContext } from "./tenant-context";
import {
  CrossTenantAccessError,
  guardTenantRow,
  PublicTenantRejectedError,
} from "./tenant-row-guard";

const ALPHA = `ten_${"a1b2c3d4e5f6g7h8"}`;
const BETA = `ten_${"z9y8x7w6v5u4t3s2"}`;

describe("tenant row guard (cross-tenant deny)", () => {
  test("a row owned by the current tenant is returned unchanged", async () => {
    const row = { tenant_id: ALPHA, id: "rec_1" };
    const guarded = await runInTenantContext(ALPHA, async () => guardTenantRow(row));
    expect(guarded).toBe(row);
  });

  test("a row owned by another tenant is denied", async () => {
    await runInTenantContext(ALPHA, async () => {
      expect(() => guardTenantRow({ tenant_id: BETA, id: "rec_2" })).toThrow(
        CrossTenantAccessError,
      );
    });
  });

  test("guarding a row without any tenant context is denied", () => {
    expect(() => guardTenantRow({ tenant_id: ALPHA, id: "rec_3" })).toThrow(
      MissingTenantContextError,
    );
  });

  test("the public service tenant is rejected on private rows", async () => {
    // DATA-LIFECYCLE.md: "public is not a private tenant";
    // "product-private schemas reject it".
    await runInTenantContext("public", async () => {
      expect(() => guardTenantRow({ tenant_id: "public", id: "rec_4" })).toThrow(
        PublicTenantRejectedError,
      );
    });
  });

  test("a row with a missing tenant_id is denied", async () => {
    await runInTenantContext(ALPHA, async () => {
      expect(() => guardTenantRow({ tenant_id: "", id: "rec_5" })).toThrow(CrossTenantAccessError);
    });
  });

  test("a row whose tenant_id is undefined fails closed", async () => {
    // The type says string, but a JS caller could pass undefined; the guard
    // must still deny (fail closed), never let it through.
    await runInTenantContext(ALPHA, async () => {
      expect(() =>
        guardTenantRow({ tenant_id: undefined as unknown as string, id: "rec_6" }),
      ).toThrow(CrossTenantAccessError);
    });
  });
});
