# DPIA template (Art. 35 GDPR / AIPD)

Manual template mirroring `src/aida-template.ts` (`DPIAAssessment`). Copy it
into the product's documentation, fill every section, and have the owner sign.
Approval is a manual owner act: nothing in CI generates, validates or approves
a DPIA at this increment (owner decision 2026-07-23 — scaffold only).

## Identification

- **Assessment id:** `dpia-<product>-<period>`
- **Product:** `libre-ai/<product>`
- **Scope:** what processing is being assessed
- **Date:** ISO 8601 timestamp
- **Version:** version of the dataset/algorithm under assessment

## Art. 35(3) screening questions

Answer each with yes/no; when yes, describe.

| Question                                                                                                                    | Yes/No | Description |
| --------------------------------------------------------------------------------------------------------------------------- | ------ | ----------- |
| Systematic and extensive automated decision-making (incl. profiling) with legal or similar effect?                          |        |             |
| Large-scale processing?                                                                                                     |        |             |
| Large-scale processing of Art. 9 special categories (or Art. 10 data)? If yes, list the `special-category` data categories. |        |             |
| Vulnerable data subjects (children, employees, asylum seekers, …)?                                                          |        |             |

## Risks

One row per identified risk to the rights and freedoms of data subjects.

| Risk description | Severity (low / medium / high) | Mitigation |
| ---------------- | ------------------------------ | ---------- |
|                  |                                |            |

## Sign-off

- **Approved by (role):** owner / dpo / legal
- **Name:**
- **Date:**

Without a completed sign-off the assessment is a draft, and the processing it
covers has no DPIA evidence.
