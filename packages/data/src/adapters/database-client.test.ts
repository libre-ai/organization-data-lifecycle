import { describe, expect, test } from "bun:test";
import {
  createClient,
  InvalidDatabaseUriError,
  type SessionConnection,
  type SessionPool,
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
    const client = createClient("postgresql://db-one.invalid:5432/one");
    try {
      expect(client.options.adapter).toBe("postgres");
      expect(client.options.max).toBe(5);
      // The runtime reports its timeouts in milliseconds.
      expect(client.options.idleTimeout).toBe(20 * 1000);
      expect(client.options.connectionTimeout).toBe(5 * 1000);
    } finally {
      await client.close();
    }
  });

  test("refuses anything but a PostgreSQL URI, without echoing it", () => {
    // The runtime would otherwise open a file (SQLite) or dial another engine.
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

/** A pool handing out one scripted connection, counting what happens to it. */
function scriptedPool(result: unknown): {
  pool: SessionPool;
  calls: Call[];
  counters: { reserved: number; released: number };
} {
  const calls: Call[] = [];
  const counters = { reserved: 0, released: 0 };
  const connection: SessionConnection = {
    unsafe: async (text, values) => {
      calls.push({ text, values });
      return result;
    },
    release: () => {
      counters.released += 1;
    },
  };
  const pool: SessionPool = {
    reserve: async () => {
      counters.reserved += 1;
      return connection;
    },
  };
  return { pool, calls, counters };
}

describe("withDedicatedSession", () => {
  test("runs every statement on the one reserved connection, then releases it", async () => {
    const rows = [{ id: "0001_first" }];
    const { pool, calls, counters } = scriptedPool(rows);

    const outcome = await withDedicatedSession(pool, async (session) => {
      expect(counters).toEqual({ reserved: 1, released: 0 });
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
    ]);
    expect(counters).toEqual({ reserved: 1, released: 1 });
  });

  test("releases the connection when the callback throws, and rethrows", async () => {
    const { pool, counters } = scriptedPool([]);
    const failure = new Error("boom");

    const outcome = withDedicatedSession(pool, async () => {
      throw failure;
    });

    await expect(outcome).rejects.toBe(failure);
    expect(counters).toEqual({ reserved: 1, released: 1 });
  });

  test("refuses a driver result that is not a row list", async () => {
    const { pool, counters } = scriptedPool({ unexpected: true });

    const outcome = withDedicatedSession(pool, (session) => session.query("SELECT 1"));

    await expect(outcome).rejects.toBeInstanceOf(TypeError);
    expect(counters).toEqual({ reserved: 1, released: 1 });
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
