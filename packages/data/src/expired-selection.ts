/**
 * Expired-record selection for the owner-scoped retention job
 * (DATA-LIFECYCLE.md, retention execution).
 *
 * Given records with creation instants, a retention window in days and the
 * current instant, this returns the opaque IDs whose age has reached the
 * window. A shorter retention therefore schedules already-expired records
 * immediately. The instant is passed explicitly — no wall-clock read — so the
 * job is deterministic and its evidence reproducible.
 */
const DAY_MS = 86_400_000;

export interface RetainedRecord {
  readonly id: string;
  readonly createdAt: string;
}

function parseInstant(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new RangeError(`invalid instant ${JSON.stringify(iso)}`);
  }
  return ms;
}

export function selectExpiredIds(
  records: readonly RetainedRecord[],
  now: string,
  retentionDays: number,
): string[] {
  const nowMs = parseInstant(now);
  const windowMs = retentionDays * DAY_MS;
  return records
    .filter((record) => nowMs >= parseInstant(record.createdAt) + windowMs)
    .map((record) => record.id);
}
