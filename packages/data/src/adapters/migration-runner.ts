import type { SqlExecutor } from "./executor";

/**
 * Tracked migration runner, replayable at every start: applies, in list
 * order, the migrations whose identifier is not yet recorded in
 * `schema_migrations`, and records each one once it succeeded.
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

const SAFE_MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Advisory locks are scoped to the database; every instance must ask for the
 * same key. Arbitrary constant, fixed forever.
 */
const MIGRATION_LOCK_KEY = 4_037_001;

interface AppliedRow {
  readonly id: string;
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
    listed.add(id);
  }

  await session.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  let failure: { readonly error: unknown } | undefined;
  try {
    await applyPending(session, migrations, journal);
  } catch (error) {
    failure = { error };
  }
  try {
    await session.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
  } catch (unlockError) {
    // A session lost midway rejects the unlock as well. That rejection must
    // not replace the error naming the migration; with nothing else to
    // report, it is the outcome.
    if (failure === undefined) {
      throw unlockError;
    }
  }
  if (failure !== undefined) {
    throw failure.error;
  }
}

async function applyPending(
  session: SqlExecutor,
  migrations: readonly Migration[],
  journal: MigrationJournal | undefined,
): Promise<void> {
  await session.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const recorded = await session.query<AppliedRow>("SELECT id FROM schema_migrations");
  const applied = new Set(recorded.rows.map((row) => row.id));

  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue;
    }
    journal?.(`applying migration ${migration.id}`);
    try {
      // BEGIN sits inside the try: once a migration is announced, whatever
      // rejects next is reported under its identifier.
      await session.exec("BEGIN");
      await migration.run(session);
      await session.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
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
