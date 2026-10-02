const cache = new Map<string, { disallows: string[]; fetchedAt: number }>();

export async function isAllowed(urlStr: string, userAgent = "*"): Promise<boolean> {
  try {
    const u = new URL(urlStr);
    const host = u.host;
    const cached = cache.get(host);
    if (cached && Date.now() - cached.fetchedAt < 1000 * 60 * 60) {
      return checkRules(u.pathname, cached.disallows);
    }
    const robotsUrl = `${u.protocol}//${host}/robots.txt`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(robotsUrl, { signal: ctrl.signal, headers: { "user-agent": "MiniSearchBot/0.1" } });
      if (!res.ok) {
        cache.set(host, { disallows: [], fetchedAt: Date.now() });
        return true;
      }
      const text = await res.text();
      const disallows = parseRobots(text, userAgent);
      cache.set(host, { disallows, fetchedAt: Date.now() });
      return checkRules(u.pathname, disallows);
    } finally {
      clearTimeout(t);
    }
  } catch {
    return true; // fail-open for malformed URLs
  }
}

function parseRobots(text: string, ua: string): string[] {
  const lines = text.split("\n").map((l) => l.trim());
  let relevant = false;
  let seenOtherGroup = false;
  const disallows: string[] = [];
  let currentAgents: string[] = [];

  const flush = () => {};
  for (const raw of lines) {
    const line = raw.split("#")[0].trim();
    if (!line) {
      // blank line ends a group
      if (currentAgents.length > 0) {
        relevant = currentAgents.some((a) => a === "*" || a.toLowerCase() === ua.toLowerCase());
        if (relevant && !seenOtherGroup) {
          // keep collecting until next group; simplified: first matching group wins
        }
      }
      continue;
    }
    const [fieldRaw, ...rest] = line.split(":");
    if (!rest.length) continue;
    const field = fieldRaw.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (field === "user-agent") {
      if (currentAgents.length > 0 && disallows.length >= 0 && relevant) {
        // we already captured first matching group; stop parsing further groups
        // simplified: only first matching group counts
        if (seenOtherGroup) continue;
      }
      // new group detection: if previous lines were rules, reset
      // heuristic: user-agent lines cluster together
      currentAgents.push(value.toLowerCase());
    } else if (field === "disallow") {
      const applies = currentAgents.some((a) => a === "*" || a === ua.toLowerCase());
      if (applies && value) {
        disallows.push(value);
        relevant = true;
        seenOtherGroup = true;
      }
    }
  }
  void flush;
  return disallows;
}

function checkRules(path: string, disallows: string[]): boolean {
  for (const d of disallows) {
    if (d === "/") return false;
    if (d && path.startsWith(d)) return false;
  }
  return true;
}
