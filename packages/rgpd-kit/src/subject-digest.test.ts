import { describe, expect, test } from "bun:test";
import {
  deriveSubjectDigest,
  InvalidSubjectIdentifierError,
  isOpaqueSubjectDigest,
  MalformedTenantIdError,
} from "./subject-digest";

const TENANT_A = "ten_aaaaaaaaaaaaaaaa";
const TENANT_B = "ten_bbbbbbbbbbbbbbbb";

describe("deriveSubjectDigest", () => {
  test("matches the locked golden vector — the derivation may NEVER drift", async () => {
    // sha256("libre-ai.rgpd.subject.v1:ten_aaaaaaaaaaaaaaaa:member-alice").
    // Persisted actor_digest columns (apps/sessions 0003) and every receipt
    // cross-reference depend on this exact derivation: a domain bump or
    // concatenation change would silently orphan all stored digests and
    // break access/erasure/portability. Changing this vector requires a
    // migration strategy for every adopter, not a test update.
    expect(await deriveSubjectDigest(TENANT_A, "member-alice")).toBe(
      "a4a79f3062fc82765aa2d6fddf825a4b9c9ccc9dea15ed34310c5ea4900e88d0",
    );
  });

  test("is deterministic for the same tenant and identifier", async () => {
    const first = await deriveSubjectDigest(TENANT_A, "member-42");
    const second = await deriveSubjectDigest(TENANT_A, "member-42");
    expect(first).toBe(second);
  });

  test("produces an opaque 64-hex sha-256", async () => {
    const digest = await deriveSubjectDigest(TENANT_A, "member-42");
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(isOpaqueSubjectDigest(digest)).toBe(true);
  });

  test("separates tenants: same identifier, different digests", async () => {
    const inTenantA = await deriveSubjectDigest(TENANT_A, "member-42");
    const inTenantB = await deriveSubjectDigest(TENANT_B, "member-42");
    expect(inTenantA).not.toBe(inTenantB);
  });

  test("separates identifiers within one tenant", async () => {
    const alice = await deriveSubjectDigest(TENANT_A, "member-alice");
    const bob = await deriveSubjectDigest(TENANT_A, "member-bob");
    expect(alice).not.toBe(bob);
  });

  test("rejects a malformed tenant id", async () => {
    expect(deriveSubjectDigest("tenant-1", "member-42")).rejects.toThrow(MalformedTenantIdError);
    expect(deriveSubjectDigest("public", "member-42")).rejects.toThrow(MalformedTenantIdError);
  });

  test("rejects an empty or oversized identifier", async () => {
    expect(deriveSubjectDigest(TENANT_A, "")).rejects.toThrow(InvalidSubjectIdentifierError);
    expect(deriveSubjectDigest(TENANT_A, "   ")).rejects.toThrow(InvalidSubjectIdentifierError);
    expect(deriveSubjectDigest(TENANT_A, "x".repeat(321))).rejects.toThrow(
      InvalidSubjectIdentifierError,
    );
  });
});

describe("isOpaqueSubjectDigest", () => {
  test("rejects anything that is not a lowercase 64-hex string", () => {
    expect(isOpaqueSubjectDigest("user@example.com")).toBe(false);
    expect(isOpaqueSubjectDigest("A".repeat(64))).toBe(false);
    expect(isOpaqueSubjectDigest("a".repeat(63))).toBe(false);
    expect(isOpaqueSubjectDigest(`${"a".repeat(64)} `)).toBe(false);
  });
});
