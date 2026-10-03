// TLS material lookup.
//
// Certificates are files on disk, not code, so this is mostly careful path
// resolution plus the one thing that actually bites people: a renewal that
// rewrites the files does nothing for a server that already loaded them. So we
// also report the certificate's notAfter, and the server can be asked to reload.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG } from "./config.ts";

export interface TlsMaterial {
  cert: string;
  key: string;
  certPath: string;
  keyPath: string;
  /** Days until the certificate expires; null when we cannot tell. */
  daysLeft?: number;
  notAfter?: string;
  issuer?: string;
}

export interface TlsStatus {
  enabled: boolean;
  reason?: string;
  certPath?: string;
  keyPath?: string;
  notAfter?: string;
  daysLeft?: number;
  issuer?: string;
  /** Set when the files look like something we should not serve. */
  warning?: string;
}

function candidatePaths(envVar: string, fallback: string): string[] {
  const fromEnv = (process.env[envVar] ?? "").trim();
  const out: string[] = [];
  if (fromEnv) out.push(resolve(fromEnv));
  for (const dir of CONFIG.server.tls.searchDirs) out.push(resolve(dir, fallback));
  return out;
}

/** First existing path, or null. */
function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (existsSync(p) && statSync(p).size > 0) return p;
    } catch {
      // unreadable: try the next candidate
    }
  }
  return null;
}

/**
 * Days until `notAfter`, read with openssl when it is available. Parsing DER by
 * hand is not worth it, and a missing openssl only costs us the warning.
 */
function inspect(certPath: string): { daysLeft?: number; notAfter?: string; issuer?: string } {
  const out: { daysLeft?: number; notAfter?: string; issuer?: string } = {};
  try {
    const endDate = Bun.spawnSync({
      cmd: ["openssl", "x509", "-in", certPath, "-noout", "-enddate"],
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = endDate.stdout?.toString().trim() ?? "";
    const m = /notAfter=(.+)$/.exec(text);
    if (m) {
      out.notAfter = m[1].trim();
      const when = Date.parse(out.notAfter);
      if (Number.isFinite(when)) out.daysLeft = Math.floor((when - Date.now()) / 86_400_000);
    }
    const issuer = Bun.spawnSync({
      cmd: ["openssl", "x509", "-in", certPath, "-noout", "-issuer"],
      stdout: "pipe",
      stderr: "ignore",
    });
    const it = issuer.stdout?.toString().trim() ?? "";
    if (it) out.issuer = it.replace(/^issuer=/, "").trim();
  } catch {
    // openssl not installed: expiry is simply unknown
  }
  return out;
}

/** Load cert+key if both are present. Returns null to mean "serve plain HTTP". */
export function loadTls(): TlsMaterial | null {
  if (!CONFIG.server.tls.enabled) return null;
  const certPath = firstExisting(candidatePaths(CONFIG.server.tls.certEnv, CONFIG.server.tls.certFile));
  const keyPath = firstExisting(candidatePaths(CONFIG.server.tls.keyEnv, CONFIG.server.tls.keyFile));
  if (!certPath || !keyPath) return null;
  return { certPath, keyPath, ...inspect(certPath), cert: "", key: "" };
}

export function tlsStatus(): TlsStatus {
  const tls = loadTls();
  if (!tls) {
    return {
      enabled: false,
      reason: `no certificate found (looked for ${CONFIG.server.tls.certFile} + ${CONFIG.server.tls.keyFile} in ${CONFIG.server.tls.searchDirs.join(", ")})`,
    };
  }
  const status: TlsStatus = {
    enabled: true,
    certPath: tls.certPath,
    keyPath: tls.keyPath,
    notAfter: tls.notAfter,
    daysLeft: tls.daysLeft,
    issuer: tls.issuer,
  };
  if (tls.daysLeft !== undefined && tls.daysLeft < 0) status.warning = "certificate has expired";
  else if (tls.daysLeft !== undefined && tls.daysLeft <= 7) status.warning = `expires in ${tls.daysLeft} day(s): renew now`;
  return status;
}

/** One line for the boot log. */
export function describeTls(): string {
  const s = tlsStatus();
  if (!s.enabled) return `http (${s.reason})`;
  const when = s.notAfter ? `, valid until ${s.notAfter}` : "";
  return `https (${s.certPath}${when})`;
}