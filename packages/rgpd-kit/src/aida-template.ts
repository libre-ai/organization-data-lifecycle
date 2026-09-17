// DPIA scaffolding (Art. 35 GDPR / AIPD; design §4.4). Scaffold ONLY at this
// increment (owner decision 2026-07-23): the kit produces an empty,
// unapproved assessment the owner fills and signs manually — no CI wiring,
// no approval workflow. The markdown counterpart lives in
// packages/rgpd-kit/docs/aida-template.md.

import type { DataCategory } from "./data-category";

export interface DpiaYesNoQuestion {
  readonly yesNo: boolean;
  readonly description?: string;
}

export interface DPIAAssessment {
  readonly id: string;
  readonly product: string;
  readonly scope: string;
  readonly date: string;
  readonly version: string;

  // Art. 35(3) mandatory screening questions.
  readonly automaticDecisionMaking: DpiaYesNoQuestion;
  readonly largeScaleProcessing: DpiaYesNoQuestion;
  readonly specialCategoryData: DpiaYesNoQuestion & {
    readonly categories?: readonly DataCategory[];
  };
  readonly vulnerableSubjects: DpiaYesNoQuestion;

  readonly risks: readonly {
    readonly description: string;
    readonly severity: "low" | "medium" | "high";
    readonly mitigation: string;
  }[];

  /** Manual owner act — never pre-filled by the scaffold. */
  readonly approvedBy?: {
    readonly role: "owner" | "dpo" | "legal";
    readonly date: string;
    readonly name: string;
  };
}

export class InvalidDpiaScaffoldError extends Error {
  constructor(field: string) {
    super(`invalid DPIA scaffold input: ${field}`);
    this.name = "InvalidDpiaScaffoldError";
  }
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface DpiaScaffoldInput {
  readonly id: string;
  readonly product: string;
  readonly scope: string;
  readonly date: string;
  readonly version: string;
}

export function createDpiaScaffold(input: DpiaScaffoldInput): DPIAAssessment {
  for (const field of ["id", "product", "scope", "version"] as const) {
    if (input[field].trim() === "") {
      throw new InvalidDpiaScaffoldError(field);
    }
  }
  if (!TIMESTAMP.test(input.date)) {
    throw new InvalidDpiaScaffoldError("date");
  }
  return {
    id: input.id,
    product: input.product,
    scope: input.scope,
    date: input.date,
    version: input.version,
    automaticDecisionMaking: { yesNo: false },
    largeScaleProcessing: { yesNo: false },
    specialCategoryData: { yesNo: false },
    vulnerableSubjects: { yesNo: false },
    risks: [],
  };
}
