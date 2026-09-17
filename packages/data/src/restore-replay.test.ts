import { describe, expect, test } from "bun:test";

import {
  type DeletionReceiptLike,
  replayDeletionsOnRestore,
  UnknownReceiptStatusError,
} from "./restore-replay";

const receipt = (subjectDigests: string[], status = "complete"): DeletionReceiptLike => ({
  subjectDigests,
  status,
});

describe("restore replays accepted deletions", () => {
  test("a restored subject named by a completed receipt does not resurrect", () => {
    const survivors = replayDeletionsOnRestore(["dig_a", "dig_b", "dig_c"], [receipt(["dig_b"])]);
    expect(survivors).toEqual(["dig_a", "dig_c"]);
  });

  test("a restored subject with no receipt survives", () => {
    const survivors = replayDeletionsOnRestore(["dig_a"], []);
    expect(survivors).toEqual(["dig_a"]);
  });

  test("replay is idempotent", () => {
    const once = replayDeletionsOnRestore(["dig_a", "dig_b"], [receipt(["dig_b"])]);
    const twice = replayDeletionsOnRestore(once, [receipt(["dig_b"])]);
    expect(twice).toEqual(["dig_a"]);
  });

  test("a blocked (refused) receipt does not delete on restore", () => {
    // "blocked" is a valid refusal receipt: the deletion never happened.
    const survivors = replayDeletionsOnRestore(["dig_a", "dig_b"], [receipt(["dig_b"], "blocked")]);
    expect(survivors).toEqual(["dig_a", "dig_b"]);
  });

  test("an unknown status fails closed rather than silently skipping", () => {
    // A corrupt or forged receipt status must abort the restore, not be
    // silently ignored (which would let a deletion resurrect unnoticed).
    expect(() => replayDeletionsOnRestore(["dig_a"], [receipt(["dig_a"], "pending")])).toThrow(
      UnknownReceiptStatusError,
    );
    expect(() => replayDeletionsOnRestore(["dig_a"], [receipt(["dig_a"], "")])).toThrow(
      UnknownReceiptStatusError,
    );
  });

  test("multiple receipts all replay", () => {
    const survivors = replayDeletionsOnRestore(
      ["dig_a", "dig_b", "dig_c"],
      [receipt(["dig_a"]), receipt(["dig_c"])],
    );
    expect(survivors).toEqual(["dig_b"]);
  });
});
