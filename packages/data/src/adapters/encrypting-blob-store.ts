/**
 * Per-tenant encrypting decorator over the Cellar-class blob store port
 * (DATA-LIFECYCLE store classes: "explicit artifact/export/evidence blobs").
 * It implements `BlobStorePort` unchanged and sits in front of a readable
 * inner store, so the inner store never receives plaintext and the
 * server-side encryption of the bucket stops being the only barrier between
 * two tenants.
 *
 * Envelope, version 1: 4-byte big-endian version (1), 12-byte random IV,
 * ciphertext, 16-byte tag. AES-256-GCM under a data key derived per call with
 * HKDF-SHA-256 (empty salt, info `libre-ai.blob-dek.v1:<tenantId>`). The
 * associated data `libre-ai.blob.v1\n<tenantId>\n<digest>` authenticates the
 * version, the tenant and the address: another tenant's object, an object
 * copied under another address and an altered object are indistinguishable,
 * all refused as `blob.tampered`.
 *
 * The digest stays the caller's address; it is never derived from the
 * envelope. Deletion stays enqueue-only and is delegated as is. The real
 * object store and key vault arrive with G4 provisioning.
 */
import { isPrivateTenantId } from "../tenant-id";
import type { BlobMetadata, BlobStorePort } from "./blob-store-port";

export interface ReadableBlobStorePort extends BlobStorePort {
  /** Raw bytes stored at this address, or null when nothing is there. */
  read(digest: string): Promise<Uint8Array | null>;
}

export class InMemoryReadableBlobStore implements ReadableBlobStorePort {
  private readonly blobs = new Map<string, { bytes: Uint8Array; metadata: BlobMetadata }>();
  private readonly deletionQueue: string[] = [];

  async put(digest: string, bytes: Uint8Array, metadata: BlobMetadata): Promise<void> {
    // Copied both ways: a caller mutating its buffer must not rewrite the store.
    this.blobs.set(digest, { bytes: Uint8Array.from(bytes), metadata });
  }

  async read(digest: string): Promise<Uint8Array | null> {
    const stored = this.blobs.get(digest);
    return stored === undefined ? null : Uint8Array.from(stored.bytes);
  }

  async enqueueContentAddressedDeletion(digests: readonly string[]): Promise<string[]> {
    const enqueued: string[] = [];
    for (const digest of digests) {
      if (this.blobs.has(digest)) {
        this.deletionQueue.push(digest);
        enqueued.push(digest);
      }
    }
    return enqueued;
  }

  pendingDeletions(): string[] {
    return [...this.deletionQueue];
  }
}

export interface BlobMasterKeyPort {
  /** 32 bytes. Called once, by the factory. */
  masterKey(): Promise<Uint8Array>;
}

export type BlobRefusalCode = "blob.truncated" | "blob.unknown-version" | "blob.tampered";

export type BlobReadResult =
  | { readonly kind: "found"; readonly bytes: Uint8Array }
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly code: BlobRefusalCode };

// The three errors below report a length, never the offending value: a key, a
// tenant id or an address from an untrusted path must not reach a log.
export class InvalidMasterKeyError extends Error {
  constructor(length: number) {
    super(`blob master key must be ${MASTER_KEY_BYTES} bytes, received ${length}`);
    this.name = "InvalidMasterKeyError";
  }
}

export class RejectedBlobTenantError extends Error {
  constructor(length: number) {
    super(`encrypted blobs require a private tenant id, received a value of length ${length}`);
    this.name = "RejectedBlobTenantError";
  }
}

export class MalformedBlobDigestError extends Error {
  constructor(length: number) {
    super(`blob address must be 64 lowercase hex characters, received a value of length ${length}`);
    this.name = "MalformedBlobDigestError";
  }
}

export interface EncryptingBlobStore extends BlobStorePort {
  get(digest: string, tenantId: string): Promise<BlobReadResult>;
  refusals(): Readonly<Record<BlobRefusalCode, number>>;
}

const MASTER_KEY_BYTES = 32;
const ENVELOPE_VERSION = 1;
const VERSION_BYTES = 4;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = VERSION_BYTES + IV_BYTES;
const MINIMUM_ENVELOPE_BYTES = HEADER_BYTES + TAG_BYTES;
const BLOB_DIGEST = /^[a-f0-9]{64}$/;
const UTF8 = new TextEncoder();

function assertAddress(digest: string, tenantId: string): void {
  if (!isPrivateTenantId(tenantId)) {
    throw new RejectedBlobTenantError(tenantId.length);
  }
  if (!BLOB_DIGEST.test(digest)) {
    throw new MalformedBlobDigestError(digest.length);
  }
}

/** Derived on every call, never cached: no data key outlives its operation. */
async function deriveDataKey(master: CryptoKey, tenantId: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: UTF8.encode(`libre-ai.blob-dek.v1:${tenantId}`),
    },
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Both formats are validated and exclude the line feed, so the join is unambiguous. */
function associatedData(tenantId: string, digest: string): Uint8Array<ArrayBuffer> {
  return UTF8.encode(`libre-ai.blob.v1\n${tenantId}\n${digest}`);
}

function isAuthenticationFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "OperationError";
}

export async function createEncryptingBlobStore(options: {
  readonly inner: ReadableBlobStorePort;
  readonly keys: BlobMasterKeyPort;
}): Promise<EncryptingBlobStore> {
  const { inner } = options;
  const raw = await options.keys.masterKey();
  if (raw.length !== MASTER_KEY_BYTES) {
    throw new InvalidMasterKeyError(raw.length);
  }
  // Non-extractible, and `raw` goes out of scope with this factory: the store
  // holds the key handle only, never the bytes.
  const master = await crypto.subtle.importKey("raw", Uint8Array.from(raw), "HKDF", false, [
    "deriveKey",
  ]);
  const refused: Record<BlobRefusalCode, number> = {
    "blob.truncated": 0,
    "blob.unknown-version": 0,
    "blob.tampered": 0,
  };

  function refuse(code: BlobRefusalCode): BlobReadResult {
    refused[code] += 1;
    return { kind: "refused", code };
  }

  return {
    async put(digest: string, bytes: Uint8Array, metadata: BlobMetadata): Promise<void> {
      assertAddress(digest, metadata.tenantId);
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const dataKey = await deriveDataKey(master, metadata.tenantId);
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: associatedData(metadata.tenantId, digest),
            tagLength: TAG_BYTES * 8,
          },
          dataKey,
          Uint8Array.from(bytes),
        ),
      );
      const envelope = new Uint8Array(HEADER_BYTES + sealed.length);
      new DataView(envelope.buffer).setUint32(0, ENVELOPE_VERSION, false);
      envelope.set(iv, VERSION_BYTES);
      envelope.set(sealed, HEADER_BYTES);
      await inner.put(digest, envelope, metadata);
    },

    async get(digest: string, tenantId: string): Promise<BlobReadResult> {
      assertAddress(digest, tenantId);
      const stored = await inner.read(digest);
      if (stored === null) {
        return { kind: "absent" };
      }
      if (stored.length < MINIMUM_ENVELOPE_BYTES) {
        return refuse("blob.truncated");
      }
      const envelope = Uint8Array.from(stored);
      if (new DataView(envelope.buffer).getUint32(0, false) !== ENVELOPE_VERSION) {
        return refuse("blob.unknown-version");
      }
      const dataKey = await deriveDataKey(master, tenantId);
      try {
        const clear = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: envelope.subarray(VERSION_BYTES, HEADER_BYTES),
            additionalData: associatedData(tenantId, digest),
            tagLength: TAG_BYTES * 8,
          },
          dataKey,
          envelope.subarray(HEADER_BYTES),
        );
        return { kind: "found", bytes: new Uint8Array(clear) };
      } catch (error) {
        // Only the AEAD verdict is a refusal; any other failure is not a
        // statement about the content and must not be counted as one.
        if (isAuthenticationFailure(error)) {
          return refuse("blob.tampered");
        }
        throw error;
      }
    },

    enqueueContentAddressedDeletion(digests: readonly string[]): Promise<string[]> {
      return inner.enqueueContentAddressedDeletion(digests);
    },

    refusals(): Readonly<Record<BlobRefusalCode, number>> {
      return { ...refused };
    },
  };
}
