import { createHash } from "node:crypto";
import type { SqlExecutor } from "./executor";

/**
 * Tracked migration runner, replayable at every start: applies, in list
 * order, the migrations whose identifier is not yet recorded in
 * `public.schema_migrations`, and records each one, with the checksum of its
 * declared content, once it succeeded. A recorded migration whose content
 * changed stops the start. Session settings a migration leaves behind
 * (search_path, role) are reset before the next one and at the end of the run.
 *
 * Two guarantees carry the "never replayed" invariant:
 *
 * - each migration and its record share ONE transaction (PostgreSQL DDL is
 *   transactional): a failure, or a crash between the two, leaves neither;
 * - a session advisory lock is held for the whole run and the applied set is
 *   read only once it is granted, so of two instances starting together the
 *   second one waits, then sees what the first one applied.
 *
 * Both need every statement on the SAME session: `session` is one dedicated
 * connection (PGlite, or `withDedicatedSession` in database-client.ts), never
 * a pool.
 *
 * The list is append-only: add at the end, never reorder.
 */
export interface Migration {
  readonly id: string;
  /**
   * Receives the runner's own session, inside the transaction that also
   * carries the record. It must not end that transaction itself: the session
   * is lent whole, so a COMMIT issued here cannot be stopped, and what it
   * made durable is neither undone nor recorded if the migration then fails.
   */
  run(session: SqlExecutor): Promise<void>;
  /**
   * The text this migration applies, typically its SQL. Its SHA-256 is
   * recorded with the identifier, and a start whose content no longer matches
   * the recorded one is refused (`MigrationChangedError`): an applied
   * migration is never edited, a new one is appended. Mandatory: `run` is code
   * the runner cannot read, so without a content an edit would go unseen. A
   * missing or blank content is refused before any SQL
   * (`InvalidMigrationContentError`).
   */
  readonly content: string;
}

export type MigrationJournal = (message: string) => void;

export class InvalidMigrationIdError extends Error {
  constructor(id: unknown) {
    // The value is not echoed: the shape check is what keeps journal lines
    // and error messages free of anything but a plain identifier.
    const shape = typeof id === "string" ? `a ${id.length}-char value` : `a ${typeof id} value`;
    super(`malformed migration identifier (${shape})`);
    this.name = "InvalidMigrationIdError";
  }
}

/**
 * A migration declares no content, a blank one, or one that is not a text.
 * Content is what lets a start see that an applied migration was edited, so
 * a migration without it is refused before any SQL. A TypeError: the shape of
 * the value is wrong. The content is not echoed.
 */
export class InvalidMigrationContentError extends TypeError {
  readonly migrationId: string;

  constructor(migrationId: string, reason: "missing" | "not-text") {
    super(
      reason === "missing"
        ? `migration ${migrationId} declares no content`
        : `migration ${migrationId} declares a content that is not a text`,
    );
    this.name = "InvalidMigrationContentError";
    this.migrationId = migrationId;
  }
}

export class DuplicateMigrationIdError extends Error {
  constructor(id: string) {
    super(`migration ${id} is listed more than once`);
    this.name = "DuplicateMigrationIdError";
  }
}

export class MigrationFailedError extends Error {
  readonly migrationId: string;

  constructor(migrationId: string, cause: unknown) {
    // The cause stays a property: a driver message can quote row values, and
    // this message is what ends up in logs.
    super(`migration ${migrationId} failed`, { cause });
    this.name = "MigrationFailedError";
    this.migrationId = migrationId;
  }
}

export class MigrationChangedError extends Error {
  readonly migrationId: string;

  constructor(migrationId: string) {
    super(`migration ${migrationId} changed after it was applied`);
    this.name = "MigrationChangedError";
    this.migrationId = migrationId;
  }
}

const SAFE_MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Advisory locks are scoped to the database; every instance must ask for the
 * same key. Arbitrary constant, fixed forever.
 */
const MIGRATION_LOCK_KEY = 4_037_001;

/**
 * Schema-qualified, and every function called by its `pg_catalog` name: a
 * migration may change the session's search_path, and until the session is
 * reset an unqualified name can resolve to a table or function of its own.
 * `public` is where the unqualified name landed under the default search_path.
 */
const TRACKING_TABLE = "public.schema_migrations";

interface AppliedRow {
  readonly id: string;
  readonly checksum: string | null;
}

function checksumOf(migration: Migration): string {
  return createHash("sha256").update(migration.content, "utf8").digest("hex");
}

export async function migrate(
  session: SqlExecutor,
  migrations: readonly Migration[],
  journal?: MigrationJournal,
): Promise<void> {
  const listed = new Set<string>();
  for (const migration of migrations) {
    // The type is checked at run time too: a list built from data can carry
    // `undefined` or a number, which the pattern would coerce to text and pass.
    const id: unknown = migration.id;
    if (typeof id !== "string" || !SAFE_MIGRATION_ID.test(id)) {
      throw new InvalidMigrationIdError(id);
    }
    if (listed.has(id)) {
      throw new DuplicateMigrationIdError(id);
    }
    // Checked at run time too: an untyped caller can still omit it.
    const content: unknown = migration.content;
    if (content === undefined || content === null) {
      throw new InvalidMigrationContentError(id, "missing");
    }
    if (typeof content !== "string") {
      throw new InvalidMigrationContentError(id, "not-text");
    }
    if (content.trim() === "") {
      throw new InvalidMigrationContentError(id, "missing");
    }
    listed.add(id);
  }

  await session.query("SELECT pg_catalog.pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  let failure: { readonly error: unknown } | undefined;
  try {
    await applyPending(session, migrations, journal);
  } catch (error) {
    failure = { error };
  }
  // The reset comes before the unlock: the session is handed back with the
  // settings it had, whatever the migrations set. A session lost midway
  // rejects both; neither rejection replaces the error naming the migration,
  // and with nothing else to report, the first one is the outcome.
  for (const cleanUp of [resetSessionState, releaseLock]) {
    try {
      await cleanUp(session);
    } catch (cleanUpError) {
      if (failure === undefined) {
        failure = { error: cleanUpError };
      }
    }
  }
  if (failure !== undefined) {
    throw failure.error;
  }
}

/**
 * A non-LOCAL `SET` (search_path, a role) issued by a migration survives its
 * COMMIT. RESET ALL leaves the role alone, hence RESET ROLE. Never DISCARD
 * ALL here: it would release the run's advisory lock.
 */
async function resetSessionState(session: SqlExecutor): Promise<void> {
  await session.exec("RESET ALL");
  await session.exec("RESET ROLE");
}

async function releaseLock(session: SqlExecutor): Promise<void> {
  await session.query("SELECT pg_catalog.pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
}

async function applyPending(
  session: SqlExecutor,
  migrations: readonly Migration[],
  journal: MigrationJournal | undefined,
): Promise<void> {
  await session.exec(
    `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
       id text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT pg_catalog.now()
     )`,
  );
  // Added apart from the CREATE: a table written before the checksum existed
  // gains the column, and its rows stay without one (NULL).
  await session.exec(`ALTER TABLE ${TRACKING_TABLE} ADD COLUMN IF NOT EXISTS checksum text`);
  const recorded = await session.query<AppliedRow>(`SELECT id, checksum FROM ${TRACKING_TABLE}`);
  const applied = new Map(recorded.rows.map((row) => [row.id, row.checksum]));

  // Every applied migration is checked before any pending one runs: an edited
  // one stops the start with the database untouched.
  const backfill: { readonly id: string; readonly checksum: string }[] = [];
  for (const migration of migrations) {
    if (!applied.has(migration.id)) {
      continue;
    }
    const recordedChecksum = applied.get(migration.id) ?? null;
    const checksum = checksumOf(migration);
    if (recordedChecksum === null) {
      // Applied before a checksum was recorded: nothing to compare with. The
      // current one is recorded from now on.
      backfill.push({ id: migration.id, checksum });
    } else if (checksum !== recordedChecksum) {
      throw new MigrationChangedError(migration.id);
    }
  }
  for (const { id, checksum } of backfill) {
    await session.query(
      `UPDATE ${TRACKING_TABLE} SET checksum = $2 WHERE id = $1 AND checksum IS NULL`,
      [id, checksum],
    );
  }

  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue;
    }
    journal?.(`applying migration ${migration.id}`);
    try {
      // The reset and BEGIN sit inside the try: once a migration is
      // announced, whatever rejects next is reported under its identifier.
      await resetSessionState(session);
      await session.exec("BEGIN");
      await migration.run(session);
      await session.query(`INSERT INTO ${TRACKING_TABLE} (id, checksum) VALUES ($1, $2)`, [
        migration.id,
        checksumOf(migration),
      ]);
      await session.exec("COMMIT");
    } catch (error) {
      await rollbackIfReachable(session);
      throw new MigrationFailedError(migration.id, error);
    }
    journal?.(`${migration.id} applied`);
  }
}

/**
 * A session that rejects ROLLBACK is lost, and the server aborts the
 * transaction of a lost session by itself. The migration's own error is the
 * one to report, so this rejection is dropped. A session still alive with its
 * transaction open cannot be reset afterwards: `withDedicatedSession` closes
 * it instead of giving it back to the pool.
 */
async function rollbackIfReachable(session: SqlExecutor): Promise<void> {
  try {
    await session.exec("ROLLBACK");
  } catch {
    // Dropped on purpose, see above.
  }
}
