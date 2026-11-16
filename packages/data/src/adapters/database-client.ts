import { SQL } from "bun";
import type { SqlExecutor } from "./executor";

/**
 * PostgreSQL client factory. Every call builds a new pool that the caller
 * owns and closes (`client.close()`): no module-level instance, so several
 * applications can live side by side in one test process.
 *
 * The driver is the runtime's native SQL client — no dependency. Its pool is
 * lazy (no connection until the first query) and it exposes no server-notice
 * hook: there is nothing to silence.
 */
export class InvalidDatabaseUriError extends Error {
  constructor() {
    // Never echo the URI: it carries the password.
    super("database URI must be a postgres:// or postgresql:// URL");
    this.name = "InvalidDatabaseUriError";
  }
}

const POSTGRES_SCHEMES = new Set(["postgres:", "postgresql:"]);

export function createClient(uri: string): SQL {
  // The runtime picks its engine from the string's shape: left unchecked, a
  // bare path would open a SQLite file and a mysql:// URL would dial MySQL.
  if (!URL.canParse(uri) || !POSTGRES_SCHEMES.has(new URL(uri).protocol)) {
    throw new InvalidDatabaseUriError();
  }
  return new SQL(uri, {
    adapter: "postgres",
    max: 5,
    idleTimeout: 20,
    connectionTimeout: 5,
  });
}

/** What the session bridge needs from a pool: one dedicated connection. */
export interface SessionPool {
  reserve(): Promise<SessionConnection>;
}

export interface SessionConnection {
  unsafe(text: string, values?: unknown[]): PromiseLike<unknown>;
  release(): void;
}

/**
 * Lends ONE connection of the pool as the adapters' `SqlExecutor`, and gives
 * it back when `fn` settles. BEGIN/COMMIT and session advisory locks only
 * mean something on a single session; sent to the pool itself they would land
 * on different connections.
 *
 * NOT yet qualified against a provisioned PostgreSQL (G4): the tests cover
 * the reserve/release discipline and the statement forwarding, not the wire.
 */
export async function withDedicatedSession<T>(
  pool: SessionPool,
  fn: (session: SqlExecutor) => Promise<T>,
): Promise<T> {
  const connection = await pool.reserve();
  try {
    return await fn({
      async query<R = Record<string, unknown>>(text: string, params?: unknown[]) {
        const result = await connection.unsafe(text, params);
        if (!Array.isArray(result)) {
          throw new TypeError("the driver did not return a row list");
        }
        return { rows: [...result] as R[] };
      },
      async exec(text: string) {
        await connection.unsafe(text);
      },
    });
  } finally {
    connection.release();
  }
}
