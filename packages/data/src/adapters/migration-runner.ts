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
 * connection (PGlite, or `DatabaseClient.withSession`), never a pool.
 *
 * The list is append-only: add at the end, never reorder.
 */
export interface Migration {
  readonly id: string;
  run(session: SqlExecutor): Promise<void>;
}

export type MigrationJournal = (message: string) => void;

export class InvalidMigrationIdError extends Error {
  constructor(id: string) {
    // The value is not echoed: the shape check is what keeps journal lines
    // and error messages free of anything but a plain identifier.
    super(`malformed migration identifier (a ${id.length}-char value)`);
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
    if (!SAFE_MIGRATION_ID.test(migration.id)) {
      throw new InvalidMigrationIdError(migration.id);
    }
    if (listed.has(migration.id)) {
      throw new DuplicateMigrationIdError(migration.id);
    }
    listed.add(migration.id);
  }

  await session.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  try {
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
      await session.exec("BEGIN");
      try {
        await migration.run(session);
        await session.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
        await session.exec("COMMIT");
      } catch (error) {
        await session.exec("ROLLBACK");
        throw new MigrationFailedError(migration.id, error);
      }
      journal?.(`${migration.id} applied`);
    }
  } finally {
    await session.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
  }
}
