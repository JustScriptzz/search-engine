// How much memory this process may actually use.
//
// The VPS has 1 GB, but a Pterodactyl container does not get all of it: the
// panel caps the container, and cgroup v2 enforces the cap without the process
// ever seeing a free-memory reading that reflects it. Guessing is how you get
// OOM-killed at 100 MB of steady-state usage — which is exactly what happened
// to the first fill run.
//
// So: ask cgroup what the limit is, and use the smaller of that and whatever we
// were told to believe.
import { totalmem } from "node:os";
import { readFileSync } from "node:fs";

export interface MemoryLimit {
  bytes: number;
  /** Where the number came from, for the log. */
  source: "cgroup-v2" | "cgroup-v1" | "os-total" | "fallback";
}

/** cgroup reports "max" when unlimited. */
export function parseCgroupLimit(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v || v === "max") return null;
  const n = Number.parseInt(v, 10);
  // A cgroup v1 "limit" of a huge number means unlimited in practice.
  if (!Number.isFinite(n) || n <= 0 || n > 1 << 62) return null;
  return n;
}

/**
 * Best available ceiling in bytes.
 *
 * @param configured what CONFIG says we may use, as a fallback and upper bound
 */
export function memoryLimit(configured: number, opts: { read?: (p: string) => string | null } = {}): MemoryLimit {
  const read = opts.read ?? defaultRead;
  // cgroup v2 first, then v1. Both are cheap stat calls.
  const v2 = parseCgroupLimit(read("/sys/fs/cgroup/memory.max"));
  if (v2) return { bytes: Math.min(configured, v2), source: "cgroup-v2" };
  const v1 = parseCgroupLimit(read("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
  if (v1) return { bytes: Math.min(configured, v1), source: "cgroup-v1" };
  const os = totalmem();
  if (os > 0) return { bytes: Math.min(configured, os), source: "os-total" };
  return { bytes: configured, source: "fallback" };
}

function defaultRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Human-readable for the log: "512 MB (cgroup-v2)". */
export function describeLimit(l: MemoryLimit): string {
  return `${Math.round((l.bytes / 1_048_576) * 10) / 10} MB (${l.source})`;
}