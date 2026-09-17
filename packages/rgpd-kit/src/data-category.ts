// RGPD data-category taxonomy (GDPR Art. 4(1), Art. 6(1), Art. 9; design
// docs/superpowers/specs/2026-07-23-rgpd-kit-first-increment-design.md §4.1).
// Pure types and fail-closed validators: rgpd-kit persists nothing — each
// product declares its categories and owns its data inside its own bounded
// context. A declaration references a retention rule by id from the machine
// policy contracts/data/retention.v1.json; the rule itself stays canonical
// there, never duplicated here.

export const DATA_CATEGORIES = [
  "identity",
  "contact",
  "profile-preference",
  "interaction",
  "communication",
  "evaluation",
  "special-category",
  "timestamp",
  "audit",
] as const;
export type DataCategory = (typeof DATA_CATEGORIES)[number];

export const LEGAL_BASES = [
  "consent",
  "contract",
  "legal-obligation",
  "vital-interests",
  "public-task",
  "legitimate-interests",
] as const;
export type LegalBasis = (typeof LEGAL_BASES)[number];

// How Art. 17 erasure applies to the category. "deferred" covers append-only
// stores where the accepted transaction removes logical access and physical
// compaction follows the retention path (DATA-LIFECYCLE §Explicit deletion);
// "never" is reserved for Art. 17(3) exceptions (immutable evidence).
export const ERASURE_SCOPES = ["immediate", "deferred", "never"] as const;
export type ErasureScope = (typeof ERASURE_SCOPES)[number];

// Retention rule ids as written in contracts/data/retention.v1.json
// (e.g. "sessions-content").
const RETENTION_RULE_ID = /^[a-z][a-z0-9-]*$/;

export interface DataCategoryDeclaration {
  readonly category: DataCategory;
  readonly description: string;
  readonly legalBasis: LegalBasis;
  readonly retentionRule: string;
  readonly erasureScope: ErasureScope;
}

export class InvalidDataCategoryDeclarationError extends Error {
  // Never echo the offending value: free-text fields may carry the very PII
  // this kit exists to keep out of compliance records. Name the field only.
  constructor(field: string) {
    super(`invalid data-category declaration: ${field}`);
    this.name = "InvalidDataCategoryDeclarationError";
  }
}

function isIn<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function validateDataCategoryDeclaration(input: unknown): DataCategoryDeclaration {
  if (typeof input !== "object" || input === null) {
    throw new InvalidDataCategoryDeclarationError("declaration must be an object");
  }
  const candidate = input as Record<string, unknown>;
  if (!isIn(DATA_CATEGORIES, candidate.category)) {
    throw new InvalidDataCategoryDeclarationError("category");
  }
  if (typeof candidate.description !== "string" || candidate.description.trim() === "") {
    throw new InvalidDataCategoryDeclarationError("description");
  }
  if (!isIn(LEGAL_BASES, candidate.legalBasis)) {
    throw new InvalidDataCategoryDeclarationError("legalBasis");
  }
  if (
    typeof candidate.retentionRule !== "string" ||
    !RETENTION_RULE_ID.test(candidate.retentionRule)
  ) {
    throw new InvalidDataCategoryDeclarationError("retentionRule");
  }
  if (!isIn(ERASURE_SCOPES, candidate.erasureScope)) {
    throw new InvalidDataCategoryDeclarationError("erasureScope");
  }
  return {
    category: candidate.category,
    description: candidate.description,
    legalBasis: candidate.legalBasis,
    retentionRule: candidate.retentionRule,
    erasureScope: candidate.erasureScope,
  };
}
