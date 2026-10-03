import { describe, expect, test } from "bun:test";
import { Frontier } from "./frontier.ts";

describe("frontier", () => {
  test("dedups and respects per-host politeness", () => {
    const f = new Frontier(["https://example.com/a", "https://example.com/a"], 100_000);
    expect(f.seenCount).toBe(1);
    expect(f.pendingCount).toBe(1);
    expect(f.popReady()).toBe("https://example.com/a");
    expect(f.popReady()).toBe(null);
  });

  test("serves a different host while the first is cooling down", () => {
    const f = new Frontier(["https://a.test/1", "https://b.test/1"], 60_000);
    expect(f.popReady()).toBe("https://a.test/1");
    expect(f.popReady()).toBe("https://b.test/1");
  });
});