import { describe, expect, test } from "bun:test";
import { describeLimit, memoryLimit, parseCgroupLimit } from "./memory.ts";
import { CONFIG } from "./config.ts";

const MB = 1_048_576;

describe("cgroup limits", () => {
  test("reads a byte limit", () => {
    expect(parseCgroupLimit("536870912")).toBe(536_870_912);
    expect(parseCgroupLimit("  536870912\n")).toBe(536_870_912);
  });

  test('"max" means unlimited, not a huge number', () => {
    expect(parseCgroupLimit("max")).toBeNull();
    expect(parseCgroupLimit("")).toBeNull();
    expect(parseCgroupLimit(null)).toBeNull();
    expect(parseCgroupLimit("0")).toBeNull();
    // cgroup v1 spells "unlimited" as a number near the address space size
    expect(parseCgroupLimit("9223372036854771712")).toBeNull();
  });
});

describe("which ceiling we enforce", () => {
  test("a container limit smaller than our config wins", () => {
    // The case that matters: we believed 700 MB, the container allows 512 MB.
    const l = memoryLimit(700 * MB, {
      read: (p) => (p.endsWith("memory.max") ? String(512 * MB) : null),
    });
    expect(l.bytes).toBe(512 * MB);
    expect(l.source).toBe("cgroup-v2");
  });

  test("cgroup v1 is used when v2 is absent", () => {
    const l = memoryLimit(700 * MB, {
      read: (p) => (p.includes("memory.limit_in_bytes") ? String(400 * MB) : null),
    });
    expect(l.bytes).toBe(400 * MB);
    expect(l.source).toBe("cgroup-v1");
  });

  test("a container larger than our config does not raise the ceiling", () => {
    // Being conservative on purpose: CONFIG is what we are willing to spend.
    const l = memoryLimit(300 * MB, {
      read: (p) => (p.endsWith("memory.max") ? String(4 * 1024 * MB) : null),
    });
    expect(l.bytes).toBe(300 * MB);
  });

  test("falls back to the machine's memory when cgroup says nothing", () => {
    const l = memoryLimit(700 * MB, { read: () => null });
    expect(l.source).toBe("os-total");
    expect(l.bytes).toBeGreaterThan(0);
    expect(l.bytes).toBeLessThanOrEqual(700 * MB);
  });

  test("the guard fires below the enforced ceiling", () => {
    // If the enforced limit were above the config value, the guard would never
    // trip and the kernel would kill us first — which is what went wrong.
    const enforced = memoryLimit(CONFIG.storage.memoryLimitBytes, { read: () => null }).bytes;
    expect(enforced).toBeLessThanOrEqual(CONFIG.storage.memoryLimitBytes);
    expect(enforced * CONFIG.storage.memoryStopPct).toBeLessThanOrEqual(enforced);
  });

  test("describes itself readably", () => {
    const l = memoryLimit(700 * MB, { read: (p) => (p.endsWith("memory.max") ? String(512 * MB) : null) });
    expect(describeLimit(l)).toBe("512 MB (cgroup-v2)");
  });
});