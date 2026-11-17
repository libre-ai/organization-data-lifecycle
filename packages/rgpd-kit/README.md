# @libre-ai/rgpd-kit

Transverse RGPD/GDPR compliance brick for the constellation: typed models
(Art. 4–22), the `DataSubjectRightsPort` products implement, Art. 30
processing-register generation, DPIA (Art. 35) scaffolding, and a simplified
consent lifecycle with per-purpose Art. 7(4) checks.

Design: `docs/superpowers/specs/2026-07-23-rgpd-kit-first-increment-design.md`
(option A — typed models + ports). First adopter: Sessions
(`apps/sessions/src/rgpd/`).

## The bounded-context hard rule

**Erasure, tombstones, receipts and audit trails are per-bounded-context,
per-database.** There is NO global deletion-receipt table, NO cross-context
audit log, NO centralized PII registry, and this package has **zero persistent
tables, zero migrations and zero runtime dependencies** — pure types,
validators and generators. Each product:

- implements `DataSubjectRightsPort` against its own store;
- owns its migrations, deletion queries and deletion receipts
  (`@libre-ai/data` per-product infrastructure);
- answers a data-subject request for its own context only. No transaction
  spans two databases; a request affects one product at a time.

A proposal that adds a shared erasure table or routes requests through a
central orchestrator is architecturally wrong here (design §7, option B —
rejected).

## Opaque subject digests (never plaintext PII)

Past `verifySubject`, everything speaks in opaque digests
(`deriveSubjectDigest`: domain-separated, tenant-scoped sha-256). Request
records, tombstones and audit rows never store the plaintext identifier; a
receipt is cross-referenced by digest inside the product's own database
(design Appendix B). Error messages in this package never echo identifier or
free-text values.

## How a product adopts the port

1. Depend on `@libre-ai/rgpd-kit` (`workspace:*`) and import
   `DataSubjectRightsPort` + the request/result types. No new types, no
   product-specific contracts.
2. Implement the port against the product's own store, with typed refusals
   (owner-prefixed codes like `sessions.rgpd.subject_unknown`).
3. Authorize BEFORE invoking the port (deny-by-default) — same boundary as
   `executeActiveDeletion` in `@libre-ai/data`.
4. Add the product's own migrations for tombstone/audit tables (append-only,
   FORCE RLS, tenant-scoped), in the product's `migrations/`.
5. Declare an Art. 30 `ProcessingActivity` (see
   `apps/sessions/art30-register.json`) referencing a retention rule id from
   `contracts/data/retention.v1.json`.
6. Integration-test the flow against the real grants (PGlite via
   `@libre-ai/testing`).

## Erasure semantics on append-only stores

Sessions' event log is structurally append-only (`GRANT SELECT, INSERT` only).
Art. 17 erasure therefore removes **logical access inside the accepted
transaction** — tombstone row + deletion receipt, both persisted atomically by
`executeActiveDeletion` — and physical compaction follows the owner-scoped
retention path (DATA-LIFECYCLE §Explicit deletion: "Physical compaction may
follow, but logical access … removed in the accepted transaction"). Such
categories declare `erasureScope: "deferred"`.

## Erasure request lifecycle (guarded transitions, retraction window)

`transitionErasureRequest(request, input)` is a pure function: it reads no
store, no clock, and calls no hook. It admits five moves on the existing
`REQUEST_STATUSES` and refuses every other pair, a status to itself included,
with `IllegalRequestTransitionError` (request id and current status only):

| From           | To             | Meaning                                              |
| -------------- | -------------- | ---------------------------------------------------- |
| `received`     | `acknowledged` | the controller accepts the request                   |
| `received`     | `refused`      | refusal or withdrawal — refusal code required        |
| `acknowledged` | `in-progress`  | erasure starts, only once the retraction window ends |
| `acknowledged` | `refused`      | withdrawal during the window, or late refusal        |
| `in-progress`  | `fulfilled`    | erasure completed                                    |

`fulfilled` and `refused` are terminal. A failed erasure has no status: the
request stays `in-progress`, the product propagates the error and may retry.
A withdrawal by the data subject is a move to `refused` with an owner-prefixed
code the product documents. Only `rightType: "erasure"` requests are accepted.

The retraction window is data, not a constant of this package: the move to
`in-progress` takes `retractionDays` (a whole number, no default) and is
refused with `RetractionWindowOpenError` while `input.at` precedes
`computeEarliestErasureAt(receivedAt, retractionDays)`. A negative or
fractional delay, or one that reaches the request's response deadline, is an
`InvalidRetractionDelayError`.

What stays with the product, in its own database (hard rule above):

- persist the returned request with an update conditional on
  `transition.from`; zero rows changed is a conflict, not a success;
- write one audit row per returned transition in its own append-only table,
  carrying the subject digest, never the plaintext identifier or free text;
- keep `retractionDays` in its configuration.

## Sessions example (first adopter)

- Port implementation: `apps/sessions/src/rgpd/data-subject-rights.ts`
  (access + erasure + portability + restriction implemented; see
  `apps/sessions/README.md`'s RGPD section for the restriction invariant and
  the two-step Art. 18(3) lift).
- Tombstone + audit migrations: `apps/sessions/migrations/0002_rgpd.sql`
  (`session_deleted_subjects`, `session_subject_audit` — append-only, FORCE
  RLS).
- Request handler: `apps/sessions/src/rgpd/request-handler.ts` — exported
  factory, **not mounted** on the public cockpit routes: the Sessions runtime
  boundary stays locked until WP-G3-S01's `sessions-authz-review` human gate.
- Art. 30 entry: `apps/sessions/art30-register.json`.

## Deferred (documented, not silently dropped)

- **Consent withdrawal automation** — products keep simple consent models; a
  cross-product "revoke everywhere" surface is G3+.
- **DPIA approval workflow** — scaffold + manual template only
  (`docs/aida-template.md`); no CI wiring (owner decision 2026-07-23).
- **Cross-product request view** — each product tracks its own requests.
- **Subject-verification SLA** — products verify via existing session/email;
  no centralized identity broker.
- **Legal hold / court orders** — documented in ADR-0002 and DATA-LIFECYCLE
  §Legal hold; implementation deferred until the enforcement process is
  defined (owner decision 2026-07-23).

## État du projet

<!-- libre-ai:project-status:begin -->
<!-- Section générée depuis project.v1.yaml — ne pas éditer à la main. -->

- Situation actuelle : Née verte en γ 3.4 (ex packages/rgpd-kit) ; sessions l'exerce de bout en bout.
- Maturité : usable
- Exposition : spec-published
- Confiance : medium
- Preuves vérifiées le : 2026-07-30
- Avancement : 50 % du périmètre actuellement déclaré

<!-- libre-ai:project-status:end -->

La fiche [`project.v1.yaml`](./project.v1.yaml) est l'autorité de l'état du projet ; cette section en est générée et le gate de flotte échoue si elles divergent.
