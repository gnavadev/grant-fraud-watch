import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Load .env from project root once (no dotenv dependency). */
export function loadEnv(): void {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(__dirname, "..", ".env"),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq <= 0) continue;
        const key = t.slice(0, eq).trim();
        let val = t.slice(eq + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = val;
      }
      return;
    } catch {
      /* try next */
    }
  }
}

/** SAM Entity API key from SAM Account Details (not Data.gov). */
export function getSamApiKey(): string | undefined {
  return process.env.SAM_API_KEY?.trim() || undefined;
}

/** FAC / api.fac.gov uses a Data.gov API key in X-Api-Key. */
export function getFacApiKey(): string | undefined {
  return (
    process.env.FAC_API_KEY?.trim() ||
    process.env.DATA_GOV_API_KEY?.trim() ||
    process.env.API_GOV_KEY?.trim() ||
    undefined
  );
}
