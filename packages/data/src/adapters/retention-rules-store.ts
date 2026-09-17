import { type RetentionRule, resolveConfiguredRetention } from "../retention-bounds";
import { requireTenantContext } from "../tenant-context";
import type { SqlExecutor } from "./executor";

/**
 * Tenant retention configuration store. The application-layer validation
 * (contract minima/maxima, retention-bounds) runs BEFORE any SQL: an invalid
 * value never reaches the database. The tenant always comes from the active
 * context — the RLS WITH CHECK policy would deny any drift anyway.
 */
export interface UpsertRetentionRuleInput {
  readonly rule: RetentionRule;
  readonly requested: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface StoredRetentionRule {
  readonly tenantId: string;
  readonly ruleId: string;
  readonly retention: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

interface RetentionRuleRow {
  readonly tenant_id: string;
  readonly rule_id: string;
  readonly retention: string;
  readonly updated_by: string;
  readonly updated_at: string;
}

export async function upsertRetentionRule(
  executor: SqlExecutor,
  input: UpsertRetentionRuleInput,
): Promise<void> {
  const retention = resolveConfiguredRetention(input.rule, input.requested);
  const tenantId = requireTenantContext();
  await executor.query(
    `INSERT INTO retention_rules (tenant_id, rule_id, retention, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, rule_id)
     DO UPDATE SET retention = EXCLUDED.retention,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = EXCLUDED.updated_at`,
    [tenantId, input.rule.id, retention, input.updatedBy, input.updatedAt],
  );
}

export async function getRetentionRule(
  executor: SqlExecutor,
  ruleId: string,
): Promise<StoredRetentionRule | null> {
  const res = await executor.query<RetentionRuleRow>(
    "SELECT tenant_id, rule_id, retention, updated_by, updated_at FROM retention_rules WHERE rule_id = $1",
    [ruleId],
  );
  const row = res.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    tenantId: row.tenant_id,
    ruleId: row.rule_id,
    retention: row.retention,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}
