// Minimal .env loader (no dependency): KEY=value lines, # comments, quotes,
// and `export KEY=value`. Values already in process.env win.
const ENV_FILE = ".env";

export async function loadEnvFile(path = ENV_FILE): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return out;
}