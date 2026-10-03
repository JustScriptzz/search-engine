import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "./config.ts";

const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "minisearch-tls-"));
  dirs.push(d);
  return d;
}

/**
 * Point the loader at a throwaway directory using the documented env overrides
 * rather than poking CONFIG, which is deliberately immutable.
 */
function useDir(dir: string, names = { cert: "fullchain.pem", key: "privkey.pem" }) {
  process.env[CONFIG.server.tls.certEnv] = join(dir, names.cert);
  process.env[CONFIG.server.tls.keyEnv] = join(dir, names.key);
  return () => {
    delete process.env[CONFIG.server.tls.certEnv];
    delete process.env[CONFIG.server.tls.keyEnv];
  };
}

const CERT = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const KEY = "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n";

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("TLS material", () => {
  test("both files present means HTTPS", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "fullchain.pem"), CERT);
    writeFileSync(join(dir, "privkey.pem"), KEY);
    const restore = useDir(dir);
    const { loadTls, tlsStatus } = await import("./tls.ts");
    const tls = loadTls();
    const status = tlsStatus();
    restore();
    expect(tls).not.toBeNull();
    expect(tls!.certPath.endsWith("fullchain.pem")).toBe(true);
    expect(tls!.keyPath.endsWith("privkey.pem")).toBe(true);
    expect(status.enabled).toBe(true);
  });

  test("a missing certificate degrades to HTTP instead of throwing", async () => {
    const dir = tmp();
    const restore = useDir(dir);
    const { loadTls, tlsStatus } = await import("./tls.ts");
    const tls = loadTls();
    const status = tlsStatus();
    restore();
    // Booting must not depend on certificates existing: a box where renewal has
    // not run yet still has to serve something.
    expect(tls).toBeNull();
    expect(status.enabled).toBe(false);
    expect(status.reason).toContain("fullchain.pem");
  });

  test("half a pair is not TLS", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "fullchain.pem"), CERT); // no private key
    const restore = useDir(dir);
    const { loadTls } = await import("./tls.ts");
    const tls = loadTls();
    restore();
    expect(tls).toBeNull();
  });

  test("an empty file is treated as absent", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "fullchain.pem"), "");
    writeFileSync(join(dir, "privkey.pem"), KEY);
    const restore = useDir(dir);
    const { loadTls } = await import("./tls.ts");
    const tls = loadTls();
    restore();
    expect(tls).toBeNull();
  });

  test("TLS_KEY_FILE / TLS_CERT_FILE point at the certificate", async () => {
    const dir = tmp();
    const nested = join(dir, "secrets");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "cert.pem"), CERT);
    writeFileSync(join(nested, "key.pem"), KEY);
    const restore = useDir(nested, { cert: "cert.pem", key: "key.pem" });
    const { loadTls } = await import("./tls.ts");
    const tls = loadTls();
    restore();
    expect(tls?.certPath).toBe(join(nested, "cert.pem"));
    expect(tls?.keyPath).toBe(join(nested, "key.pem"));
  });

  test("a wrong override does not fall back to the workspace", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "fullchain.pem"), CERT);
    writeFileSync(join(dir, "privkey.pem"), KEY);
    // Point at files that do not exist: an explicit override should fail loudly
    // rather than quietly serving a different certificate than the operator set.
    process.env[CONFIG.server.tls.certEnv] = join(dir, "absent.pem");
    process.env[CONFIG.server.tls.keyEnv] = join(dir, "absent.pem");
    const { loadTls } = await import("./tls.ts");
    const tls = loadTls();
    delete process.env[CONFIG.server.tls.certEnv];
    delete process.env[CONFIG.server.tls.keyEnv];
    // absent.pem has no size>0 file, so nothing resolves and we stay on HTTP.
    expect(tls).toBeNull();
  });

  test("configuration names the files the cert script writes", () => {
    expect(CONFIG.server.tls.enabled).toBe(true);
    expect(CONFIG.server.tls.certFile).toBe("fullchain.pem");
    expect(CONFIG.server.tls.keyFile).toBe("privkey.pem");
  });
});