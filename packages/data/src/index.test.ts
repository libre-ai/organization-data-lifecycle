import { describe, expect, test } from "bun:test";
import * as databaseClient from "./adapters/database-client";
import * as migrationRunner from "./adapters/migration-runner";
import * as entry from "./index";

/**
 * The package exposes a single entry (`exports["."]`): what is not re-exported
 * there does not exist for a consumer.
 */
describe("package entry", () => {
  test("exposes the migration runner and its errors", () => {
    const exposed: Record<string, unknown> = entry;
    expect(exposed.migrate).toBe(migrationRunner.migrate);
    expect(exposed.MigrationFailedError).toBe(migrationRunner.MigrationFailedError);
    expect(exposed.InvalidMigrationIdError).toBe(migrationRunner.InvalidMigrationIdError);
    expect(exposed.DuplicateMigrationIdError).toBe(migrationRunner.DuplicateMigrationIdError);
  });

  test("exposes the client factory, the session bridge and their errors", () => {
    const exposed: Record<string, unknown> = entry;
    expect(exposed.createClient).toBe(databaseClient.createClient);
    expect(exposed.InvalidDatabaseUriError).toBe(databaseClient.InvalidDatabaseUriError);
    expect(exposed.withDedicatedSession).toBe(databaseClient.withDedicatedSession);
    expect(exposed.SessionResetFailedError).toBe(databaseClient.SessionResetFailedError);
  });

  test("exposes the types a consumer needs to call them", () => {
    // Checked by the compiler: these imports fail typecheck when one is missing.
    const migration: entry.Migration = { id: "0001_first", run: async () => {} };
    const journal: entry.MigrationJournal = () => {};
    const pool: entry.SessionPool | undefined = undefined;
    const connection: entry.SessionConnection | undefined = undefined;
    expect(migration.id).toBe("0001_first");
    expect(typeof journal).toBe("function");
    expect(pool).toBeUndefined();
    expect(connection).toBeUndefined();
  });
});
