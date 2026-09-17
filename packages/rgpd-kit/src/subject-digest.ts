// Opaque subject digest (design Appendix B): a data-subject request record,
// tombstone or audit row never stores the plaintext identifier — only its
// tenant-scoped sha-256. The digest is domain-separated so it can never
// collide with another digest family, and tenant-scoped so the same person in
// two tenants yields two unrelated digests (receipts stay per-context).
// Products cross-reference the digest with the deletion receipt held in their
// own database; nothing here persists anything.

// contracts/schemas/common.v1.schema.json#/$defs/tenantId (private tenants
// only: the "public" service tenant never names a data subject).
const PRIVATE_TENANT_ID = /^ten_[a-z0-9]{16,64}$/;
// contracts/schemas/common.v1.schema.json#/$defs/sha256
const SHA256_DIGEST = /^[a-f0-9]{64}$/;

const DIGEST_DOMAIN = "libre-ai.rgpd.subject.v1";
const MAX_IDENTIFIER_LENGTH = 320;

const encoder = new TextEncoder();

export class MalformedTenantIdError extends Error {
  constructor() {
    super("subject digest requires a private tenant id (ten_…)");
    this.name = "MalformedTenantIdError";
  }
}

export class InvalidSubjectIdentifierError extends Error {
  // Never echo the identifier: it is the PII this module exists to conceal.
  constructor() {
    super(`subject identifier must be non-blank and at most ${MAX_IDENTIFIER_LENGTH} characters`);
    this.name = "InvalidSubjectIdentifierError";
  }
}

export async function deriveSubjectDigest(
  tenantId: string,
  subjectIdentifier: string,
): Promise<string> {
  if (!PRIVATE_TENANT_ID.test(tenantId)) {
    throw new MalformedTenantIdError();
  }
  if (subjectIdentifier.trim() === "" || subjectIdentifier.length > MAX_IDENTIFIER_LENGTH) {
    throw new InvalidSubjectIdentifierError();
  }
  const bytes = encoder.encode(`${DIGEST_DOMAIN}:${tenantId}:${subjectIdentifier}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function isOpaqueSubjectDigest(value: string): boolean {
  return SHA256_DIGEST.test(value);
}
