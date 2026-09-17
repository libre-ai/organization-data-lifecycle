/**
 * Configured-retention validation (DATA-LIFECYCLE.md, retention execution).
 *
 * Tenant-configurable retention is validated between the accepted minimum and
 * maximum. Values below the minimum or beyond the maximum are refused. Fixed
 * rules cannot be configured. Durations are ISO-8601; the machine policy uses
 * only day and year components (`P<n>D`, `P<n>Y`), so a year compares as 365
 * days for bound checks — the exactness a retention boundary requires.
 */
export class NotConfigurableError extends Error {
  constructor(ruleId: string) {
    super(`retention rule ${JSON.stringify(ruleId)} is not configurable`);
    this.name = "NotConfigurableError";
  }
}

export class BelowMinimumRetentionError extends Error {
  constructor(requested: string, minimum: string) {
    super(`retention ${requested} is below the accepted minimum ${minimum}`);
    this.name = "BelowMinimumRetentionError";
  }
}

export class AboveMaximumRetentionError extends Error {
  constructor(requested: string, maximum: string) {
    super(`retention ${requested} is beyond the accepted maximum ${maximum}`);
    this.name = "AboveMaximumRetentionError";
  }
}

export class NonPositiveRetentionError extends Error {
  constructor(requested: string) {
    super(`configured retention ${requested} must be a positive duration`);
    this.name = "NonPositiveRetentionError";
  }
}

export interface RetentionRule {
  readonly id: string;
  readonly mode: string;
  readonly defaultRetention?: string;
  readonly configurable?: { readonly minimum?: string; readonly maximum?: string };
}

// The machine policy uses a single component, P<n>D or P<n>Y, never both.
const ISO_DAY_OR_YEAR = /^P(?:(\d+)Y|(\d+)D)$/;

function toDays(iso: string): number {
  const match = ISO_DAY_OR_YEAR.exec(iso);
  if (match === null) {
    throw new RangeError(`unsupported retention duration ${JSON.stringify(iso)}`);
  }
  const years = match[1] === undefined ? 0 : Number.parseInt(match[1], 10);
  const days = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);
  return years * 365 + days;
}

/**
 * ISO-8601 retention window (`P<n>D` or `P<n>Y`) as an integer day count. The
 * single parser the sweep orchestrator reuses to turn a stored or
 * contract-default window into the days a selection query needs — day/year
 * normalization stays defined once, here, never reimplemented at the call site.
 */
export function retentionDurationDays(iso: string): number {
  return toDays(iso);
}

export function resolveConfiguredRetention(rule: RetentionRule, requested: string): string {
  if (rule.configurable === undefined) {
    throw new NotConfigurableError(rule.id);
  }
  const requestedDays = toDays(requested);
  if (requestedDays <= 0) {
    throw new NonPositiveRetentionError(requested);
  }
  const { minimum, maximum } = rule.configurable;
  if (minimum !== undefined && requestedDays < toDays(minimum)) {
    throw new BelowMinimumRetentionError(requested, minimum);
  }
  if (maximum !== undefined && requestedDays > toDays(maximum)) {
    throw new AboveMaximumRetentionError(requested, maximum);
  }
  return requested;
}
