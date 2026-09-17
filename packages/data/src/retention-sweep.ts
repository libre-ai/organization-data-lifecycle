import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SqlExecutor } from "./adapters/executor";
import { getRetentionRule } from "./adapters/retention-rules-store";
import { withTenantRetentionTransaction } from "./adapters/retention-transaction";
import { withTenantDbTransaction } from "./adapters/tenant-transaction";
import { retentionDurationDays } from "./retention-bounds";

/**
 * Spec-driven retention sweep for the retention execution + physical compaction
 * design (2026-07-24). This module is the GENERIC orchestrator: it owns two
 * phases and zero product knowledge. Each adopting product (first: Sessions)
 * supplies a `CompactionSpec` that carries the product-specific selection query,
 * the per-unit compaction with its in-transaction re-check, and the legal-hold
 * pre-check. The orchestrator never sees content — unit ids and receipt ids are
 * opaque strings — and never logs; it returns the evidence report.
 */

/**
 * Per-product compaction plan for ONE owner + ONE rule. The unit of physical
 * deletion is product-defined (for Sessions: a whole session stream — the
 * causal log rejects row-level holes, design DECISION 1).
 */
export interface CompactionSpec {
  /** Owner label carried into the report (e.g. "sessions"). */
  readonly owner: string;
  /** Retention rule id, resolved against `retention_rules` then the contract
   *  default (e.g. "sessions-content"). */
  readonly ruleId: string;
  /**
   * Phase 1, under the APP barrier (read-only): full-expiry selection minus
   * exclusions. Returns opaque per-unit keys (e.g. session ids) — ADVISORY
   * only: between the two phases a fresh event can be appended or a subject
   * restricted, so the authoritative check is `compactUnit`'s own re-check.
   */
  selectExpiredUnits(
    tx: SqlExecutor,
    tenantId: string,
    now: string,
    retentionDays: number,
  ): Promise<readonly string[]>;
  /**
   * Phase 2, under the RETENTION barrier, once per unit in its own bounded
   * transaction. MUST re-check the full predicate (expiry AND exclusions)
   * INSIDE this transaction and return `{ deleted: false }` untouched when it
   * no longer holds (TOCTOU guard — the selection is advisory, this check is
   * the guard). On deletion, returns the row count and the opaque receipt ids
   * of tombstoned subjects whose rows were compacted by this unit's deletion.
   */
  compactUnit(
    tx: SqlExecutor,
    tenantId: string,
    unitId: string,
    now: string,
    retentionDays: number,
  ): Promise<{
    deleted: boolean;
    eventsDeleted: number;
    compactedReceiptIds: readonly string[];
  }>;
  /**
   * Legal-hold pre-check hook. v1: implementations return a documented
   * constant-empty (the deferral is NAMED, never silent — same precedent as
   * `executeActiveDeletion`'s K4 M-09). A future hold registry plugs in here
   * without reshaping the sweep. Non-empty blocks the sweep entirely.
   */
  holds(tx: SqlExecutor, tenantId: string): Promise<readonly string[]>;
}

/**
 * Evidence report of one sweep: aggregate counts plus opaque receipt ids and
 * timestamps only — never subject identifiers, digest lists, or content. The
 * receipt ids are the restore-drill cross-check surface (they are opaque, they
 * are not identifiers).
 */
export interface RetentionEvidenceReport {
  readonly owner: string;
  readonly tenantId: string;
  readonly ruleId: string;
  readonly sessionsSelected: number;
  readonly sessionsDeleted: number;
  readonly eventsDeleted: number;
  readonly compactedReceiptIds: readonly string[];
  readonly sweptAt: string;
}

/**
 * Raised when neither a stored tenant rule nor the machine policy yields a
 * retention window for the requested rule (e.g. an until-delete/immediate rule,
 * or an unknown id). Fail-closed: the sweep refuses rather than guess a window.
 * Code-only message; the rule id is a public policy identifier, never content.
 */
export class RetentionWindowUnresolvedError extends Error {
  constructor(ruleId: string) {
    super(`retention window unresolved for rule ${JSON.stringify(ruleId)}`);
    this.name = "RetentionWindowUnresolvedError";
  }
}

interface RetentionPolicyRuleEntry {
  readonly id: string;
  readonly defaultRetention?: string;
}

interface RetentionPolicyContract {
  readonly rules: readonly RetentionPolicyRuleEntry[];
}

// Canonical machine policy: the contracts AUTHORITY at the revision pinned
// in package.json/bun.lock (ADR-0020). Resolved through module resolution so
// the lookup also works when this brick is itself an installed git-dep — a
// literal <package-root>/node_modules path only exists in this repository's
// own checkout, never under a consumer's nested install.
const RETENTION_CONTRACT_PATH = fileURLToPath(
  import.meta.resolve("@libre-ai/contracts-authority/contracts/data/retention.v1.json"),
);

async function contractDefaultRetentionDays(ruleId: string): Promise<number> {
  const raw = await readFile(RETENTION_CONTRACT_PATH, "utf8");
  const contract = JSON.parse(raw) as RetentionPolicyContract;
  const entry = contract.rules.find((rule) => rule.id === ruleId);
  if (entry?.defaultRetention === undefined) {
    throw new RetentionWindowUnresolvedError(ruleId);
  }
  return retentionDurationDays(entry.defaultRetention);
}

/**
 * Resolve the retention window (in days) for the active tenant: a stored rule
 * wins; otherwise the contract default. The stored value was validated against
 * the contract bounds at upsert (retention-rules-store), so no validation is
 * repeated here — only parsing, reused from retention-bounds. Runs under the
 * APP barrier, so `getRetentionRule` is tenant-scoped by RLS (the tenant id is
 * the transaction GUC, not a query argument).
 */
async function resolveRetentionDays(tx: SqlExecutor, ruleId: string): Promise<number> {
  const stored = await getRetentionRule(tx, ruleId);
  if (stored !== null) {
    return retentionDurationDays(stored.retention);
  }
  return contractDefaultRetentionDays(ruleId);
}

/**
 * Run one owner + one tenant sweep, two phases:
 *
 *   1. Under the APP barrier (read-only): resolve the window, run the legal-hold
 *      pre-check (non-empty ⇒ the whole sweep is blocked, report with zero
 *      selections and zero deletions), then the advisory selection.
 *   2. For each selected unit, ONE `withTenantRetentionTransaction` calling the
 *      spec's `compactUnit` — bounded per-unit transactions (design requirement).
 *
 * Error policy (SPEC DECISION, fail-closed): a per-unit error ABORTS the sweep
 * by rethrowing. Units already committed before it STAY committed (their
 * transactions are independent), no further unit runs, and the report is lost
 * on throw — acceptable for the v1 owner-run CLI, where the error surfaces to
 * the operator.
 */
export async function runRetentionSweep(
  executor: SqlExecutor,
  spec: CompactionSpec,
  tenantId: string,
  now: string,
): Promise<RetentionEvidenceReport> {
  const selection = await withTenantDbTransaction(executor, tenantId, async (tx) => {
    const retentionDays = await resolveRetentionDays(tx, spec.ruleId);
    const activeHolds = await spec.holds(tx, tenantId);
    if (activeHolds.length > 0) {
      return { retentionDays, blocked: true, unitIds: [] as readonly string[] };
    }
    const unitIds = await spec.selectExpiredUnits(tx, tenantId, now, retentionDays);
    return { retentionDays, blocked: false, unitIds };
  });

  if (selection.blocked) {
    return emptyReport(spec, tenantId, now);
  }

  let sessionsDeleted = 0;
  let eventsDeleted = 0;
  const compactedReceiptIds = new Set<string>();
  for (const unitId of selection.unitIds) {
    const outcome = await withTenantRetentionTransaction(executor, tenantId, (tx) =>
      spec.compactUnit(tx, tenantId, unitId, now, selection.retentionDays),
    );
    if (outcome.deleted) {
      sessionsDeleted += 1;
      eventsDeleted += outcome.eventsDeleted;
      for (const receiptId of outcome.compactedReceiptIds) {
        compactedReceiptIds.add(receiptId);
      }
    }
  }

  return {
    owner: spec.owner,
    tenantId,
    ruleId: spec.ruleId,
    sessionsSelected: selection.unitIds.length,
    sessionsDeleted,
    eventsDeleted,
    compactedReceiptIds: [...compactedReceiptIds],
    sweptAt: now,
  };
}

function emptyReport(spec: CompactionSpec, tenantId: string, now: string): RetentionEvidenceReport {
  return {
    owner: spec.owner,
    tenantId,
    ruleId: spec.ruleId,
    sessionsSelected: 0,
    sessionsDeleted: 0,
    eventsDeleted: 0,
    compactedReceiptIds: [],
    sweptAt: now,
  };
}
