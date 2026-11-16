import { SQL } from "bun";
import type { SqlExecutor } from "./executor";
import { clearPooledSession } from "./tenant-transaction";

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
    super("database URI must be a postgres:// or postgresql:// URL naming a host");
    this.name = "InvalidDatabaseUriError";
  }
}

/**
 * The fixed options of every client, in the driver's documented unit
 * (seconds). `adapter` pins the engine whatever the connection string says.
 * Frozen, and copied at each use: no caller can change them for the others.
 */
export const CLIENT_DEFAULTS = Object.freeze({
  adapter: "postgres",
  max: 5,
  idleTimeout: 20,
  connectionTimeout: 5,
});

const POSTGRES_URI_PREFIX = /^postgres(?:ql)?:\/\//;

/** A URL parser drops surrounding spaces, tabs and line breaks in silence. */
function hasSpaceOrControlCharacter(text: string): boolean {
  for (const character of text) {
    if (character <= " " || character === "\u007f") {
      return true;
    }
  }
  return false;
}

/**
 * With the engine pinned, the driver dials whatever host it reads in the
 * string (a bare `one.db` is a host name to it), and its default host when
 * the string names none. The string is therefore checked as written, not as
 * a parser would repair it, and must name a host.
 */
function parsePostgresUri(uri: string): URL {
  if (!POSTGRES_URI_PREFIX.test(uri) || hasSpaceOrControlCharacter(uri) || !URL.canParse(uri)) {
    throw new InvalidDatabaseUriError();
  }
  const parsed = new URL(uri);
  if (parsed.hostname === "") {
    throw new InvalidDatabaseUriError();
  }
  return parsed;
}

export function createClient(uri: string): SQL {
  // The driver receives the parsed URL: what was checked is what is dialed.
  return new SQL(parsePostgresUri(uri), { ...CLIENT_DEFAULTS });
}

/** What the session bridge needs from a pool: one dedicated connection. */
export interface SessionPool {
  reserve(): Promise<SessionConnection>;
}

export interface SessionConnection {
  unsafe(text: string, values?: unknown[]): PromiseLike<unknown>;
  /** Gives the connection back to the pool, for the next borrower. */
  release(): void;
  /** Closes this one connection; the pool opens another when it needs one. */
  close(): PromiseLike<void>;
}

export class SessionResetFailedError extends Error {
  constructor(cause: unknown) {
    // The cause stays a property, like every driver error of this package.
    super("the lent session could not be reset: its connection was closed, not returned", {
      cause,
    });
    this.name = "SessionResetFailedError";
  }
}

/**
 * Lends ONE connection of the pool as the adapters' `SqlExecutor`, and takes
 * it back when `fn` settles. BEGIN/COMMIT and session advisory locks only
 * mean something on a single session; sent to the pool itself they would land
 * on different connections.
 *
 * Nothing of the session reaches the next borrower: it is reset before its
 * return (`clearPooledSession`: role, session settings, advisory locks,
 * temporary state). A session that cannot be reset — lost, or left inside a
 * transaction — is closed instead of returned, and the call rejects: work
 * left in an open transaction was never committed.
 *
 * NOT yet qualified against a provisioned PostgreSQL (G4): the tests cover
 * the reserve/reset/release discipline and the statement forwarding, not the
 * wire. To qualify there first: the driver keeps named prepared statements
 * per connection, and the reset drops them on the server side.
 */
export async function withDedicatedSession<T>(
  pool: SessionPool,
  fn: (session: SqlExecutor) => Promise<T>,
): Promise<T> {
  const connection = await pool.reserve();
  const session: SqlExecutor = {
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
  };

  let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await fn(session) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const resetFailure = await takeBack(connection, session);

  // The callback's own error comes first: a failed reset never masks it.
  if (!outcome.ok) {
    throw outcome.error;
  }
  if (resetFailure !== undefined) {
    throw new SessionResetFailedError(resetFailure.cause);
  }
  return outcome.value;
}

/** Resets then releases; a session that cannot be reset is closed instead. */
async function takeBack(
  connection: SessionConnection,
  session: SqlExecutor,
): Promise<{ readonly cause: unknown } | undefined> {
  try {
    await clearPooledSession(session);
  } catch (cause) {
    try {
      await connection.close();
    } catch {
      // Already gone. Either way it is never released to the next borrower.
    }
    return { cause };
  }
  connection.release();
  return undefined;
}
