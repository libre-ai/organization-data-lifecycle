import { describe, expect, test } from "bun:test";
import * as entry from "../index";
import type { executeActiveDeletion } from "./active-deletion";
import * as encryptingBlobStore from "./encrypting-blob-store";
import {
  type BlobMasterKeyPort,
  type BlobRefusalCode,
  createEncryptingBlobStore,
  type EncryptingBlobStore,
  InMemoryReadableBlobStore,
  InvalidMasterKeyError,
  MalformedBlobDigestError,
  RejectedBlobTenantError,
} from "./encrypting-blob-store";

const TENANT_A = "ten_aaaaaaaaaaaaaaaa";
const TENANT_B = "ten_bbbbbbbbbbbbbbbb";
const ADDRESS_X = "1".repeat(64);
const ADDRESS_Y = "2".repeat(64);
const OWNER = "export-job";
const CLEAR = new TextEncoder().encode("blob payload of the round trip");
const NO_REFUSAL: Record<BlobRefusalCode, number> = {
  "blob.truncated": 0,
  "blob.unknown-version": 0,
  "blob.tampered": 0,
};

/** Keys are drawn at run time: no key literal lives in the repository. */
function randomKey(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

interface Fixture {
  readonly inner: InMemoryReadableBlobStore;
  readonly store: EncryptingBlobStore;
  readonly key: Uint8Array<ArrayBuffer>;
  readonly keyCalls: () => number;
}

async function fixture(): Promise<Fixture> {
  const inner = new InMemoryReadableBlobStore();
  const key = randomKey(32);
  let calls = 0;
  const keys: BlobMasterKeyPort = {
    masterKey: async () => {
      calls += 1;
      return Uint8Array.from(key);
    },
  };
  const store = await createEncryptingBlobStore({ inner, keys });
  return { inner, store, key, keyCalls: () => calls };
}

async function storedAt(inner: InMemoryReadableBlobStore, digest: string): Promise<Uint8Array> {
  const stored = await inner.read(digest);
  if (stored === null) {
    throw new Error("expected an object in the inner store");
  }
  return stored;
}

/**
 * Decrypts an envelope from the written format alone (version 1: 4-byte
 * big-endian version, 12-byte IV, ciphertext, 16-byte tag; HKDF-SHA-256 with
 * an empty salt), sharing no code with the module under test.
 */
async function decryptFromSpecification(
  key: Uint8Array<ArrayBuffer>,
  envelope: Uint8Array,
  tenantId: string,
  digest: string,
): Promise<Uint8Array> {
  const utf8 = new TextEncoder();
  const master = await crypto.subtle.importKey("raw", key, "HKDF", false, ["deriveKey"]);
  const dataKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: utf8.encode(`libre-ai.blob-dek.v1:${tenantId}`),
    },
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const bytes = Uint8Array.from(envelope);
  const clear = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes.slice(4, 16),
      additionalData: utf8.encode(`libre-ai.blob.v1\n${tenantId}\n${digest}`),
      tagLength: 128,
    },
    dataKey,
    bytes.slice(16),
  );
  return new Uint8Array(clear);
}

describe("encrypting blob store: round trip and envelope", () => {
  test("put then get with the same tenant and address returns the original bytes", async () => {
    const { store } = await fixture();
    await store.put(ADDRESS_X, CLEAR, { owner: OWNER, tenantId: TENANT_A });
    expect(await store.get(ADDRESS_X, TENANT_A)).toEqual({ kind: "found", bytes: CLEAR });
  });

  test("an empty plaintext round-trips through an envelope of exactly 32 bytes", async () => {
    const { store, inner } = await fixture();
    await store.put(ADDRESS_X, new Uint8Array(0), { owner: OWNER, tenantId: TENANT_A });
    expect((await storedAt(inner, ADDRESS_X)).length).toBe(32);
    expect(await store.get(ADDRESS_X, TENANT_A)).toEqual({
      kind: "found",
      bytes: new Uint8Array(0),
    });
  });

  test("the inner store never receives the plaintext and gets a version 1 header", async () => {
    const { store, inner } = await fixture();
    await store.put(ADDRESS_X, CLEAR, { owner: OWNER, tenantId: TENANT_A });
    const stored = await storedAt(inner, ADDRESS_X);
    expect(stored).not.toEqual(CLEAR);
    expect(stored.length).toBe(4 + 12 + CLEAR.length + 16);
    expect([...stored.subarray(0, 4)]).toEqual([0, 0, 0, 1]);
    // Hex is byte-aligned (two characters per byte): the plaintext appears nowhere inside.
    expect(stored.toHex()).not.toContain(CLEAR.toHex());
  });

  test("the stored envelope decrypts from the written format alone", async () => {
    const { store, inner, key } = await fixture();
    await store.put(ADDRESS_X, CLEAR, { owner: OWNER, tenantId: TENANT_A });
    const stored = await storedAt(inner, ADDRESS_X);
    expect(await decryptFromSpecification(key, stored, TENANT_A, ADDRESS_X)).toEqual(CLEAR);
  });

  test("two puts of the same plaintext for the same tenant give two envelopes", async () => {
    const { store, inner } = await fixture();
    await store.put(ADDRESS_X, CLEAR, { owner: OWNER, tenantId: TENANT_A });
    const first = await storedAt(inner, ADDRESS_X);
    await store.put(ADDRESS_X, CLEAR, { owner: OWNER, tenantId: TENANT_A });
    const second = await storedAt(inner, ADDRESS_X);
    expect(second).not.toEqual(first);
    expect(second.length).toBe(first.length);
  });
});

describe("encrypting blob store: refusals", () => {
  test("another tenant reading the address is refused as tampered", async () => {
    const { store, inner } = await fixture();
    await store.put(ADDRESS_X, CLEAR, { owner: OWNER, tenantId: TENANT_A });
    await store.put(ADDRESS_Y, CLEAR, { owner: OWNER, tenantId: TENANT_B });
    expect(await storedAt(inner, ADDRESS_X)).not.toEqual(await storedAt(inner, ADDRESS_Y));
    expect(await store.get(ADDRESS_X, TENANT_B)).toEqual({
      kind: "refused",
      code: "blob.tampered",
    });
  });

  test("an object copied raw under another address is refused as tampered", async () => {
    const { store, inner } = await fixture();
    const metadata = { owner: OWNER, tenantId: TENANT_A };
    await store.put(ADDRESS_X, CLEAR, metadata);
    await inner.put(ADDRESS_Y, await storedAt(inner, ADDRESS_X), metadata);
    expect(await store.get(ADDRESS_Y, TENANT_A)).toEqual({
      kind: "refused",
      code: "blob.tampered",
    });
    expect(await store.get(ADDRESS_X, TENANT_A)).toEqual({ kind: "found", bytes: CLEAR });
  });

  test.each([
    ["the IV", 4],
    ["the ciphertext", 16],
    ["the tag", 4 + 12 + CLEAR.length],
  ])("one flipped byte in %s is refused as tampered, without an exception", async (_part, offset) => {
    const { store, inner } = await fixture();
    const metadata = { owner: OWNER, tenantId: TENANT_A };
    await store.put(ADDRESS_X, CLEAR, metadata);
    const altered = await storedAt(inner, ADDRESS_X);
    altered[offset] = (altered[offset] ?? 0) ^ 0xff;
    await inner.put(ADDRESS_X, altered, metadata);
    expect(await store.get(ADDRESS_X, TENANT_A)).toEqual({
      kind: "refused",
      code: "blob.tampered",
    });
  });

  test("a version header rewritten to 2 is refused as an unknown version", async () => {
    const { store, inner } = await fixture();
    const metadata = { owner: OWNER, tenantId: TENANT_A };
    await store.put(ADDRESS_X, CLEAR, metadata);
    const rewritten = await storedAt(inner, ADDRESS_X);
    rewritten.set([0, 0, 0, 2], 0);
    await inner.put(ADDRESS_X, rewritten, metadata);
    expect(await store.get(ADDRESS_X, TENANT_A)).toEqual({
      kind: "refused",
      code: "blob.unknown-version",
    });
  });

  test("an inner object of 31 bytes is refused as truncated", async () => {
    const { store, inner } = await fixture();
    const short = new Uint8Array(31);
    short.set([0, 0, 0, 1], 0);
    await inner.put(ADDRESS_X, short, { owner: OWNER, tenantId: TENANT_A });
    expect(await store.get(ADDRESS_X, TENANT_A)).toEqual({
      kind: "refused",
      code: "blob.truncated",
    });
  });

  test("an address never written is absent", async () => {
    const { store } = await fixture();
    expect(await store.get(ADDRESS_X, TENANT_A)).toEqual({ kind: "absent" });
  });

  test("refusals start at zero, count each refusal on its code, ignore found and absent", async () => {
    const { store, inner } = await fixture();
    const metadata = { owner: OWNER, tenantId: TENANT_A };
    expect(store.refusals()).toEqual(NO_REFUSAL);

    await store.put(ADDRESS_X, CLEAR, metadata);
    await store.get(ADDRESS_X, TENANT_A);
    await store.get(ADDRESS_Y, TENANT_A);
    expect(store.refusals()).toEqual(NO_REFUSAL);

    await store.get(ADDRESS_X, TENANT_B);
    expect(store.refusals()).toEqual({ ...NO_REFUSAL, "blob.tampered": 1 });

    await inner.put(ADDRESS_Y, new Uint8Array(31), metadata);
    await store.get(ADDRESS_Y, TENANT_A);
    expect(store.refusals()).toEqual({ ...NO_REFUSAL, "blob.tampered": 1, "blob.truncated": 1 });

    const rewritten = await storedAt(inner, ADDRESS_X);
    rewritten.set([0, 0, 0, 2], 0);
    await inner.put(ADDRESS_X, rewritten, metadata);
    await store.get(ADDRESS_X, TENANT_A);
    await store.get(ADDRESS_X, TENANT_A);
    expect(store.refusals()).toEqual({
      "blob.truncated": 1,
      "blob.unknown-version": 2,
      "blob.tampered": 1,
    });
  });
});

describe("encrypting blob store: master key", () => {
  test.each([
    31, 33,
  ])("a master key of %d bytes fails the factory without leaking a byte", async (length) => {
    const key = randomKey(length);
    const attempt = createEncryptingBlobStore({
      inner: new InMemoryReadableBlobStore(),
      keys: { masterKey: async () => key },
    });
    const error: unknown = await attempt.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(InvalidMasterKeyError);
    const message = error instanceof Error ? error.message : "";
    expect(message).toBe(`blob master key must be 32 bytes, received ${length}`);
    expect(message).not.toContain(key.toHex());
    expect(message).not.toContain(key.toBase64());
    expect(message).not.toContain(key.join(","));
  });

  test("the key port is called exactly once on a successful construction", async () => {
    const { store, keyCalls } = await fixture();
    await store.put(ADDRESS_X, CLEAR, { owner: OWNER, tenantId: TENANT_A });
    await store.get(ADDRESS_X, TENANT_A);
    expect(keyCalls()).toBe(1);
  });
});

describe("encrypting blob store: caller validation", () => {
  const REJECTED_TENANTS = ["public", "ten_short", "TEN_AAAAAAAAAAAAAAAA", ""];
  const MALFORMED_ADDRESSES = [
    "1".repeat(63),
    "1".repeat(65),
    "A".repeat(64),
    `${"1".repeat(63)}\n`,
  ];

  test.each(
    REJECTED_TENANTS,
  )("put with tenant %p is rejected and writes nothing", async (tenantId) => {
    const { store, inner } = await fixture();
    const attempt = store.put(ADDRESS_X, CLEAR, { owner: OWNER, tenantId });
    await expect(attempt).rejects.toBeInstanceOf(RejectedBlobTenantError);
    await expect(attempt).rejects.toThrow(
      `encrypted blobs require a private tenant id, received a value of length ${tenantId.length}`,
    );
    expect(await inner.read(ADDRESS_X)).toBeNull();
  });

  test.each(REJECTED_TENANTS)("get with tenant %p is rejected", async (tenantId) => {
    const { store } = await fixture();
    await store.put(ADDRESS_X, CLEAR, { owner: OWNER, tenantId: TENANT_A });
    const attempt = store.get(ADDRESS_X, tenantId);
    await expect(attempt).rejects.toBeInstanceOf(RejectedBlobTenantError);
    expect(store.refusals()).toEqual(NO_REFUSAL);
  });

  test("a tenant rejection does not reproduce the value", async () => {
    const { store } = await fixture();
    const tenantId = "tenant-with-a-recognisable-name";
    const error: unknown = await store.get(ADDRESS_X, tenantId).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error instanceof Error ? error.message : "").not.toContain(tenantId);
  });

  test.each(
    MALFORMED_ADDRESSES,
  )("put with address %p is rejected and writes nothing", async (digest) => {
    const { store, inner } = await fixture();
    const attempt = store.put(digest, CLEAR, { owner: OWNER, tenantId: TENANT_A });
    await expect(attempt).rejects.toBeInstanceOf(MalformedBlobDigestError);
    await expect(attempt).rejects.toThrow(
      `blob address must be 64 lowercase hex characters, received a value of length ${digest.length}`,
    );
    expect(await inner.read(digest)).toBeNull();
  });

  test.each(MALFORMED_ADDRESSES)("get with address %p is rejected", async (digest) => {
    const { store } = await fixture();
    await expect(store.get(digest, TENANT_A)).rejects.toBeInstanceOf(MalformedBlobDigestError);
  });

  test("an address rejection does not reproduce the value", async () => {
    const { store } = await fixture();
    const digest = "not-an-address-but-recognisable";
    const error: unknown = await store.get(digest, TENANT_A).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error instanceof Error ? error.message : "").not.toContain(digest);
  });
});

describe("encrypting blob store: deletion and port shape", () => {
  test("deletion is delegated: same list as the inner store, queue fed, nothing removed", async () => {
    const { store, inner } = await fixture();
    await store.put(ADDRESS_X, CLEAR, { owner: OWNER, tenantId: TENANT_A });
    const before = await storedAt(inner, ADDRESS_X);
    expect(await store.enqueueContentAddressedDeletion([ADDRESS_X, ADDRESS_Y])).toEqual([
      ADDRESS_X,
    ]);
    expect(inner.pendingDeletions()).toEqual([ADDRESS_X]);
    expect(await storedAt(inner, ADDRESS_X)).toEqual(before);
    expect(await store.get(ADDRESS_X, TENANT_A)).toEqual({ kind: "found", bytes: CLEAR });
  });

  test("the decorator is accepted where executeActiveDeletion takes a blob store", async () => {
    // Checked by the compiler: this annotation fails typecheck if the shapes drift.
    const { store } = await fixture();
    const accepted: Parameters<typeof executeActiveDeletion>[2] = store;
    expect(accepted).toBe(store);
  });

  test("the package entry exposes the decorator, its double and its errors", () => {
    const exposed: Record<string, unknown> = entry;
    expect(exposed.createEncryptingBlobStore).toBe(encryptingBlobStore.createEncryptingBlobStore);
    expect(exposed.InMemoryReadableBlobStore).toBe(encryptingBlobStore.InMemoryReadableBlobStore);
    expect(exposed.InvalidMasterKeyError).toBe(encryptingBlobStore.InvalidMasterKeyError);
    expect(exposed.RejectedBlobTenantError).toBe(encryptingBlobStore.RejectedBlobTenantError);
    expect(exposed.MalformedBlobDigestError).toBe(encryptingBlobStore.MalformedBlobDigestError);
    // Checked by the compiler: these annotations fail typecheck when one is missing.
    const result: entry.BlobReadResult = { kind: "absent" };
    const code: entry.BlobRefusalCode = "blob.tampered";
    const keys: entry.BlobMasterKeyPort | undefined = undefined;
    const readable: entry.ReadableBlobStorePort | undefined = undefined;
    const store: entry.EncryptingBlobStore | undefined = undefined;
    expect(result.kind).toBe("absent");
    expect(code).toBe("blob.tampered");
    expect([keys, readable, store]).toEqual([undefined, undefined, undefined]);
  });
});
