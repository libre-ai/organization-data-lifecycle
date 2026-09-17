import { describe, expect, test } from "bun:test";

import {
  MissingTenantContextError,
  requireTenantContext,
  runInTenantContext,
} from "./tenant-context";
import { MalformedTenantIdError } from "./tenant-id";

const TENANT = `ten_${"a1b2c3d4e5f6g7h8"}`;

describe("tenant context deny-by-default", () => {
  test("a query without an established tenant context is denied", () => {
    // DATA-LIFECYCLE.md: "missing tenant context fails transaction".
    expect(() => requireTenantContext()).toThrow(MissingTenantContextError);
  });

  test("an established context exposes exactly its tenant id", async () => {
    const seen = await runInTenantContext(TENANT, async () => {
      return requireTenantContext();
    });
    expect(seen).toBe(TENANT);
  });

  test("the context is cleared after the scope returns (pool reuse safety)", async () => {
    await runInTenantContext(TENANT, async () => {
      return requireTenantContext();
    });
    // DATA-LIFECYCLE.md: "Connection pools clear context before reuse."
    expect(() => requireTenantContext()).toThrow(MissingTenantContextError);
  });

  test("the context is cleared even when the scope throws", async () => {
    await expect(
      runInTenantContext(TENANT, async () => {
        throw new Error("scope failure");
      }),
    ).rejects.toThrow("scope failure");
    expect(() => requireTenantContext()).toThrow(MissingTenantContextError);
  });

  test("a malformed tenant id is rejected at context establishment", () => {
    // Fail fast: a malformed id from an untrusted path must not scope access.
    expect(() => runInTenantContext("ten_short", async () => 0)).toThrow(MalformedTenantIdError);
  });
});
