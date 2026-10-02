export class Frontier {
  private queue: string[] = [];
  private seen = new Set<string>();
  private lastHit = new Map<string, number>();
  delayMs: number;

  constructor(seeds: string[], delayMs = 1000) {
    this.delayMs = delayMs;
    for (const s of seeds) this.push(s);
  }

  get seenCount() {
    return this.seen.size;
  }

  get pendingCount() {
    return this.queue.length;
  }

  push(url: string): boolean {
    const norm = normalizeKey(url);
    if (!norm || this.seen.has(norm)) return false;
    this.seen.add(norm);
    this.queue.push(norm);
    return true;
  }

  pushMany(urls: string[], limit = 5000): number {
    let n = 0;
    for (const u of urls) {
      if (this.seen.size >= limit) break;
      if (this.push(u)) n++;
    }
    return n;
  }

  /** Pop next URL that respects per-host politeness. Returns null if none ready. */
  popReady(): string | null {
    const now = Date.now();
    for (let i = 0; i < this.queue.length; i++) {
      const url = this.queue[i];
      const host = safeHost(url);
      const last = this.lastHit.get(host) ?? 0;
      if (now - last >= this.delayMs) {
        this.queue.splice(i, 1);
        this.lastHit.set(host, now);
        return url;
      }
    }
    return null;
  }
}

function normalizeKey(url: string): string | null {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}
