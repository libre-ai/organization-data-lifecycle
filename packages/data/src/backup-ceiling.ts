/**
 * Encrypted-backup expiry ceiling (DATA-LIFECYCLE.md, explicit deletion §7).
 *
 * Encrypted backups expire within 35 days of a deletion and are never
 * selectively restored. A deletion receipt's `backupExpiresAt` must not exceed
 * the deletion instant plus this ceiling. All instants are passed explicitly —
 * this module never reads the wall clock, so its output is deterministic and
 * auditable.
 */
export const BACKUP_EXPIRY_DAYS = 35;

const DAY_MS = 86_400_000;

export class BackupCeilingExceededError extends Error {
  constructor(backupExpiresAt: string, ceiling: string) {
    super(
      `backup expiry ${backupExpiresAt} exceeds the ${BACKUP_EXPIRY_DAYS}-day ceiling ${ceiling}`,
    );
    this.name = "BackupCeilingExceededError";
  }
}

function parseInstant(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new RangeError(`invalid instant ${JSON.stringify(iso)}`);
  }
  return ms;
}

export function backupExpiryCeiling(deletedAt: string): string {
  const ceilingMs = parseInstant(deletedAt) + BACKUP_EXPIRY_DAYS * DAY_MS;
  return new Date(ceilingMs).toISOString();
}

export function assertWithinBackupCeiling(deletedAt: string, backupExpiresAt: string): void {
  const ceilingMs = parseInstant(deletedAt) + BACKUP_EXPIRY_DAYS * DAY_MS;
  if (parseInstant(backupExpiresAt) > ceilingMs) {
    throw new BackupCeilingExceededError(backupExpiresAt, new Date(ceilingMs).toISOString());
  }
}
