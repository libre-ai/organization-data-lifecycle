// Art. 30 GDPR record of processing activities (design §4.3). Each product
// declares one ProcessingActivity per processing purpose family; the owner
// or DPO aggregates the declarations into a markdown register for audits and
// data-subject requests. The register aggregates DECLARATIONS — descriptions
// of processing — never the processed data itself, so generating it crosses
// no bounded-context boundary.

import type { DataCategory, LegalBasis } from "./data-category";
import { DATA_CATEGORIES, LEGAL_BASES } from "./data-category";
import type { DataSubjectRightType } from "./data-subject-request";
import { DATA_SUBJECT_RIGHT_TYPES } from "./data-subject-request";

export const DATA_SUBJECT_TYPES = ["end-user", "employee", "visitor", "lead"] as const;
export type DataSubjectType = (typeof DATA_SUBJECT_TYPES)[number];

export const TRANSFER_MECHANISMS = [
  "adequacy",
  "scc",
  "binding-corporate-rules",
  "derogation",
] as const;
export type TransferMechanism = (typeof TRANSFER_MECHANISMS)[number];

// Same replicated common.v1 patterns as the other modules.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const RETENTION_RULE_ID = /^[a-z][a-z0-9-]*$/;

export interface ProcessingActivity {
  readonly name: string;
  readonly product: string;
  readonly dataCategories: readonly DataCategory[];
  readonly purposes: readonly string[];
  readonly legalBasis: LegalBasis;
  readonly recipients: readonly string[];
  readonly retentionRule: string;
  readonly dataSubjectType: DataSubjectType;
  readonly transfersOutsideEU?: {
    readonly country: string;
    readonly mechanism: TransferMechanism;
  };
  readonly subjectRightsImplemented: readonly DataSubjectRightType[];
  readonly dpaAssessmentDate?: string;
}

export class InvalidProcessingActivityError extends Error {
  constructor(field: string) {
    super(`invalid processing activity: ${field}`);
    this.name = "InvalidProcessingActivityError";
  }
}

function isIn<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function requireNonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidProcessingActivityError(field);
  }
  return value;
}

function requireEnumList<T extends string>(
  values: readonly T[],
  input: unknown,
  field: string,
): readonly T[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new InvalidProcessingActivityError(field);
  }
  for (const entry of input) {
    if (!isIn(values, entry)) {
      throw new InvalidProcessingActivityError(field);
    }
  }
  return [...input] as T[];
}

export function validateProcessingActivity(input: unknown): ProcessingActivity {
  if (typeof input !== "object" || input === null) {
    throw new InvalidProcessingActivityError("activity must be an object");
  }
  const candidate = input as Record<string, unknown>;
  const name = requireNonBlank(candidate.name, "name");
  const product = requireNonBlank(candidate.product, "product");
  const dataCategories = requireEnumList(
    DATA_CATEGORIES,
    candidate.dataCategories,
    "dataCategories",
  );
  if (!Array.isArray(candidate.purposes) || candidate.purposes.length === 0) {
    throw new InvalidProcessingActivityError("purposes");
  }
  const purposes = candidate.purposes.map((purpose) => requireNonBlank(purpose, "purposes"));
  if (!isIn(LEGAL_BASES, candidate.legalBasis)) {
    throw new InvalidProcessingActivityError("legalBasis");
  }
  if (!Array.isArray(candidate.recipients)) {
    throw new InvalidProcessingActivityError("recipients");
  }
  const recipients = candidate.recipients.map((recipient) =>
    requireNonBlank(recipient, "recipients"),
  );
  if (
    typeof candidate.retentionRule !== "string" ||
    !RETENTION_RULE_ID.test(candidate.retentionRule)
  ) {
    throw new InvalidProcessingActivityError("retentionRule");
  }
  if (!isIn(DATA_SUBJECT_TYPES, candidate.dataSubjectType)) {
    throw new InvalidProcessingActivityError("dataSubjectType");
  }
  const subjectRightsImplemented = requireEnumList(
    DATA_SUBJECT_RIGHT_TYPES,
    candidate.subjectRightsImplemented,
    "subjectRightsImplemented",
  );
  let transfersOutsideEU: ProcessingActivity["transfersOutsideEU"];
  if (candidate.transfersOutsideEU !== undefined) {
    if (typeof candidate.transfersOutsideEU !== "object" || candidate.transfersOutsideEU === null) {
      throw new InvalidProcessingActivityError("transfersOutsideEU");
    }
    const transfer = candidate.transfersOutsideEU as Record<string, unknown>;
    const country = requireNonBlank(transfer.country, "transfersOutsideEU.country");
    if (!isIn(TRANSFER_MECHANISMS, transfer.mechanism)) {
      throw new InvalidProcessingActivityError("transfersOutsideEU.mechanism");
    }
    transfersOutsideEU = { country, mechanism: transfer.mechanism };
  }
  let dpaAssessmentDate: string | undefined;
  if (candidate.dpaAssessmentDate !== undefined) {
    if (
      typeof candidate.dpaAssessmentDate !== "string" ||
      !TIMESTAMP.test(candidate.dpaAssessmentDate)
    ) {
      throw new InvalidProcessingActivityError("dpaAssessmentDate");
    }
    dpaAssessmentDate = candidate.dpaAssessmentDate;
  }
  return {
    name,
    product,
    dataCategories,
    purposes,
    legalBasis: candidate.legalBasis,
    recipients,
    retentionRule: candidate.retentionRule,
    dataSubjectType: candidate.dataSubjectType,
    ...(transfersOutsideEU === undefined ? {} : { transfersOutsideEU }),
    subjectRightsImplemented,
    ...(dpaAssessmentDate === undefined ? {} : { dpaAssessmentDate }),
  };
}

export function generateArt30Register(activities: readonly ProcessingActivity[]): string {
  const validated = activities.map((activity) => validateProcessingActivity(activity));
  // Deterministic order: the register must not reshuffle between runs, so
  // diffs stay reviewable evidence.
  const sorted = [...validated].sort(
    (left, right) =>
      left.product.localeCompare(right.product) || left.name.localeCompare(right.name),
  );
  const sections = sorted.map((activity) => {
    const transfers =
      activity.transfersOutsideEU === undefined
        ? "none"
        : `${activity.transfersOutsideEU.country} (${activity.transfersOutsideEU.mechanism})`;
    return `## ${activity.product} — ${activity.name}

- **Purposes:** ${activity.purposes.join(", ")}
- **Legal basis:** ${activity.legalBasis}
- **Data categories:** ${activity.dataCategories.join(", ")}
- **Data subjects:** ${activity.dataSubjectType}
- **Recipients:** ${activity.recipients.join(", ")}
- **Retention rule:** ${activity.retentionRule}
- **Subject rights implemented:** ${activity.subjectRightsImplemented.join(", ")}
- **Transfers outside EU:** ${transfers}
- **Last DPIA:** ${activity.dpaAssessmentDate ?? "none"}
`;
  });
  return `# Record of processing activities (Art. 30 GDPR)

Generated by @libre-ai/rgpd-kit. One section per activity, sorted by product
then name. Each activity is declared and owned by its product inside its own
bounded context; this register aggregates declarations, never data.

${sections.join("\n")}`;
}
