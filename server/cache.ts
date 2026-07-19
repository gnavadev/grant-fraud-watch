import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FacilityFilters } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, "..", ".cache", "usaspending");

/** Default cache TTL: 12 hours. */
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

export function cacheKey(kind: string, filters: FacilityFilters): string {
  const normalized = {
    kind,
    state: filters.state?.toUpperCase() ?? "",
    city: filters.city?.trim().toLowerCase() ?? "",
    county: filters.county?.trim().toLowerCase() ?? "",
    type: filters.type ?? "all",
    q: filters.q?.trim().toLowerCase() ?? "",
  };
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 24);
  return `${kind}_${hash}`;
}

async function ensureCacheDir(): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

export async function cacheGet<T>(
  key: string,
  ttlMs = DEFAULT_TTL_MS,
): Promise<T | null> {
  try {
    const file = path.join(CACHE_DIR, `${key}.json`);
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { savedAt: number; data: T };
    if (!parsed.savedAt || Date.now() - parsed.savedAt > ttlMs) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export async function cacheSet<T>(key: string, data: T): Promise<void> {
  try {
    await ensureCacheDir();
    const file = path.join(CACHE_DIR, `${key}.json`);
    await fs.writeFile(
      file,
      JSON.stringify({ savedAt: Date.now(), data }),
      "utf8",
    );
  } catch (err) {
    // Avoid importing logger cycle; keep quiet-safe
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "cache_write_failed",
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
