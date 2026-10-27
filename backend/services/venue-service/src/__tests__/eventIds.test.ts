import { describe, expect, it } from "vitest";
import { MAX_EVENT_IDS, parseEventIds } from "../lib/eventIds.js";

describe("parseEventIds", () => {
  it.each([
    ["1", [1]],
    ["1,2,3", [1, 2, 3]],
    [" 4 , 5 ", [4, 5]],
    ["3,3,3", [3]],
    ["2,1,2,1", [2, 1]],
    ["10,9", [10, 9]],
  ])("%j is read as %j", (raw, expected) => {
    expect(parseEventIds(raw)).toEqual(expected);
  });

  it.each(["", " ", ",", "1,", ",1", "1,,2", "0", "01", "-1", "1.5", "1e2", "abc", "1,x", "1 2", "0x10", "+3"])("%j is rejected", (raw) => {
    expect(parseEventIds(raw)).toBeNull();
  });

  it.each([undefined, null, 5, ["1", "2"], ["1"], {}, true])("a non-string %j is rejected", (raw) => {
    expect(parseEventIds(raw)).toBeNull();
  });

  it("allows exactly the maximum number of ids and no more", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    expect(MAX_EVENT_IDS).toBe(100);
    expect(parseEventIds(ids(MAX_EVENT_IDS).join(","))).toEqual(ids(MAX_EVENT_IDS));
    expect(parseEventIds(ids(MAX_EVENT_IDS + 1).join(","))).toBeNull();
  });

  it("counts the ids as sent, so repeats still count towards the maximum", () => {
    expect(parseEventIds(Array(MAX_EVENT_IDS + 1).fill("1").join(","))).toBeNull();
  });
});
