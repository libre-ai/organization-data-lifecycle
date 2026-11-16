import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import {
  CLIENT_DEFAULTS,
  createClient,
  InvalidDatabaseUriError,
  type SessionConnection,
  type SessionPool,
  SessionResetFailedError,
  withDedicatedSession,
} from "./database-client";

/**
 * The pool is lazy: no connection is opened until a query is sent, so the
 * factory is exercised here without any database. `.invalid` is a reserved
 * TLD; nothing below resolves or dials it.
 */

describe("createClient", () => {
  test("two calls with two URIs return two distinct instances", async () => {
    const one = createClient("postgres://db-one.invalid:5432/one");
    const two = createClient("postgres://db-two.invalid:5432/two");
    try {
      expect(one).not.toBe(two);
      expect(one.options.hostname).toBe("db-one.invalid");
      expect(two.options.hostname).toBe("db-two.invalid");
    } finally {
      await one.close();
      await two.close();
    }
  });

  test("no instance is shared, even for the same URI", async () => {
    const uri = "postgres://db-one.invalid:5432/one";
    const first = createClient(uri);
    const second = createClient(uri);
    try {
      expect(first).not.toBe(second);
    } finally {
      await first.close();
      await second.close();
    }
  });

  test("fixed defaults: 5 connections, 20 s idle, 5 s to connect, PostgreSQL", async () => {
    // The specification, in the unit the driver's public options document: seconds.
    const specified = {
      adapter: "postgres",
      max: 5,
      idleTimeout: 20,
      connectionTimeout: 5,
    } as const;
    expect(CLIENT_DEFAULTS).toEqual(specified);

    // The driver reports timeouts in a unit of its own. The factory's client
    // is therefore compared with a client built here from the specified
    // values, never with a number copied from the driver's report.
    const uri = "postgresql://db-one.invalid:5432/one";
    const client = createClient(uri);
    const reference = new SQL(uri, { ...specified });
    const untouched = new SQL(uri);
    try {
      expect(client.options.adapter).toBe("postgres");
      expect(client.options.max).toBe(5);
      expect(client.options.idleTimeout).toBe(reference.options.idleTimeout);
      expect(client.options.connectionTimeout).toBe(reference.options.connectionTimeout);
      // The comparison means something: the driver honours each of the three.
      expect(untouched.options.max).not.toBe(reference.options.max);
      expect(untouched.options.idleTimeout).not.toBe(reference.options.idleTimeout);
      expect(untouched.options.connectionTimeout).not.toBe(reference.options.connectionTimeout);
    } finally {
      await client.close();
      await reference.close();
      await untouched.close();
    }
  });

  test("the fixed options pin the engine by themselves, whatever the string says", async () => {
    // Second barrier under the URI check: handed a string the check refuses,
    // the same options still build a PostgreSQL client. Without `adapter` the
    // driver follows the string's scheme and builds a client for that engine.
    const client = new SQL("mysql://db-one.invalid/one", { ...CLIENT_DEFAULTS });
    try {
      expect(client.options.adapter).toBe("postgres");
    } finally {
      await client.close();
    }
  });

  test("credentials and database of the URI reach the client decoded", async () => {
    const client = createClient("postgres://app:two%20words@db-one.invalid:6543/one");
    try {
      expect(client.options.hostname).toBe("db-one.invalid");
      expect(client.options.port).toBe(6543);
      expect(client.options.database).toBe("one");
      expect(client.options.username).toBe("app");
      expect(client.options.password).toBe("two words");
    } finally {
      await client.close();
    }
  });

  test("the client it returns is a pool withDedicatedSession accepts", async () => {
    const client = createClient("postgres://db-one.invalid:5432/one");
    try {
      // Checked by the compiler: the assignment fails typecheck otherwise.
      const pool: SessionPool = client;
      expect(typeof pool.reserve).toBe("function");
    } finally {
      await client.close();
    }
  });

  test("refuses anything but a PostgreSQL URI naming a host, without echoing it", () => {
    // With the engine pinned, the driver would dial whatever host it reads in
    // the string, or its own default host when the string names none.
    const marker = "not-to-be-echoed";
    const refused = [
      "",
      ":memory:",
      "one.db",
      "file:./one.db",
      `sqlite://${marker}.db`,
      `mysql://app:${marker}@db-one.invalid/one`,
      `https://app:${marker}@db-one.invalid/one`,
      `postgres ://app:${marker}@db-one.invalid/one`,
      // No host: the driver falls back on a default one.
      "postgres://",
      `postgres:///${marker}`,
      `postgres:/${marker}.db`,
      "postgres://app@/one",
      // What a URL parser drops silently never reaches the driver unseen.
      ` postgres://app:${marker}@db-one.invalid/one`,
      `postgres://app:${marker}@db-one.invalid/one\n`,
      `post\tgres://app:${marker}@db-one.invalid/one`,
      `postgres://app:${marker}@db-one\t.invalid/one`,
      `POSTGRES://app:${marker}@db-one.invalid/one`,
      `postgres://app:${marker}@db-one.invalid:99999/one`,
    ];
    for (const uri of refused) {
      let caught: unknown;
      try {
        createClient(uri);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InvalidDatabaseUriError);
      expect((caught as InvalidDatabaseUriError).message).not.toContain(marker);
    }
  });
});

interface Call {
  readonly text: string;
  readonly values: unknown[] | undefined;
}

interface Script {
  /** What every statement resolves with. */
  readonly result: unknown;
  /** Statements matching this reject with `rejection`. */
  readonly rejectOn?: RegExp;
  readonly rejection?: Error;
  readonly closeRejects?: boolean;
}

/** A pool handing out one scripted connection, logging what happens to it. */
function scriptedPool(script: Script): {
  pool: SessionPool;
  calls: Call[];
  events: string[];
} {
  const calls: Call[] = [];
  const events: string[] = [];
  const connection: SessionConnection = {
    unsafe: async (text, values) => {
      calls.push({ text, values });
      events.push(`sql ${text}`);
      if (script.rejectOn?.test(text)) {
        throw script.rejection ?? new Error("scripted rejection");
      }
      return script.result;
    },
    release: () => {
      events.push("release");
    },
    close: async () => {
      events.push("close");
      if (script.closeRejects) {
        throw new Error("already closed");
      }
    },
  };
  const pool: SessionPool = {
    reserve: async () => {
      events.push("reserve");
      return connection;
    },
  };
  return { pool, calls, events };
}

describe("withDedicatedSession", () => {
  test("runs every statement on the one reserved connection, resets it, then releases it", async () => {
    const rows = [{ id: "0001_first" }];
    const { pool, calls, events } = scriptedPool({ result: rows });

    const outcome = await withDedicatedSession(pool, async (session) => {
      expect(events).toEqual(["reserve"]);
      await session.exec("BEGIN");
      const res = await session.query<{ id: string }>("SELECT id FROM t WHERE id = $1", [
        "0001_first",
      ]);
      return res.rows;
    });

    expect(outcome).toEqual(rows);
    expect(calls).toEqual([
      { text: "BEGIN", values: undefined },
      { text: "SELECT id FROM t WHERE id = $1", values: ["0001_first"] },
      { text: "DISCARD ALL", values: undefined },
    ]);
    // The reset is the last statement of the session, and precedes its return.
    expect(events.slice(-2)).toEqual(["sql DISCARD ALL", "release"]);
    expect(events).not.toContain("close");
  });

  test("resets and releases the connection when the callback throws, and rethrows", async () => {
    const { pool, events } = scriptedPool({ result: [] });
    const failure = new Error("boom");

    const outcome = withDedicatedSession(pool, async (session) => {
      await session.exec("SET app.tenant_id = 'left-behind'");
      throw failure;
    });

    await expect(outcome).rejects.toBe(failure);
    expect(events).toEqual([
      "reserve",
      "sql SET app.tenant_id = 'left-behind'",
      "sql DISCARD ALL",
      "release",
    ]);
  });

  test("a session that cannot be reset is closed, never returned, and the call rejects", async () => {
    // What a session left inside a transaction answers to DISCARD ALL.
    const rejection = new Error("DISCARD ALL cannot run inside a transaction block");
    const { pool, events } = scriptedPool({ result: [], rejectOn: /^DISCARD ALL$/, rejection });

    let caught: unknown;
    try {
      await withDedicatedSession(pool, async (session) => {
        await session.exec("BEGIN");
        return "done";
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SessionResetFailedError);
    const failure = caught as SessionResetFailedError;
    expect(failure.cause).toBe(rejection);
    expect(failure.message).not.toContain(rejection.message);
    expect(events).toEqual(["reserve", "sql BEGIN", "sql DISCARD ALL", "close"]);
  });

  test("a failed reset does not mask the callback's own error", async () => {
    const { pool, events } = scriptedPool({ result: [], rejectOn: /^DISCARD ALL$/ });
    const failure = new Error("boom");

    const outcome = withDedicatedSession(pool, async () => {
      throw failure;
    });

    await expect(outcome).rejects.toBe(failure);
    expect(events).toEqual(["reserve", "sql DISCARD ALL", "close"]);
  });

  test("a connection that cannot even be closed is still never returned", async () => {
    const { pool, events } = scriptedPool({
      result: [],
      rejectOn: /^DISCARD ALL$/,
      closeRejects: true,
    });

    const outcome = withDedicatedSession(pool, async () => "done");

    await expect(outcome).rejects.toBeInstanceOf(SessionResetFailedError);
    expect(events).toEqual(["reserve", "sql DISCARD ALL", "close"]);
  });

  test("refuses a driver result that is not a row list", async () => {
    const { pool, events } = scriptedPool({ result: { unexpected: true } });

    const outcome = withDedicatedSession(pool, (session) => session.query("SELECT 1"));

    await expect(outcome).rejects.toBeInstanceOf(TypeError);
    expect(events).toEqual(["reserve", "sql SELECT 1", "sql DISCARD ALL", "release"]);
  });

  test("a pool that cannot reserve fails the call and releases nothing", async () => {
    const failure = new Error("pool exhausted");
    const pool: SessionPool = {
      reserve: async () => {
        throw failure;
      },
    };
    let entered = false;

    const outcome = withDedicatedSession(pool, async () => {
      entered = true;
    });

    await expect(outcome).rejects.toBe(failure);
    expect(entered).toBe(false);
  });
});
