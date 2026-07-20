import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "@upstash/redis";
import type { FacilityFilters } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, "..", ".cache", "usaspending");

/** Default cache TTL: 12 hours. */
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

const KEY_PREFIX = "gfw:";

type CacheEnvelope<T> = { savedAt: number; data: T; ttlMs: number };

let redis: Redis | null | undefined;

/**
 * Shared Upstash Redis when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set.
 * Falls back to local disk so local dev keeps working without Redis.
 */
export function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (url && token) {
    redis = new Redis({ url, token });
  } else {
    redis = null;
  }
  return redis;
}

export function cacheBackend(): "redis" | "disk" {
  return getRedis() ? "redis" : "disk";
}

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

function redisKey(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

async function ensureCacheDir(): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

async function diskGet<T>(key: string, ttlMs: number): Promise<T | null> {
  try {
    const file = path.join(CACHE_DIR, `${key}.json`);
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed.savedAt || Date.now() - parsed.savedAt > ttlMs) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

async function diskSet<T>(
  key: string,
  data: T,
  ttlMs: number,
): Promise<void> {
  await ensureCacheDir();
  const file = path.join(CACHE_DIR, `${key}.json`);
  const envelope: CacheEnvelope<T> = {
    savedAt: Date.now(),
    data,
    ttlMs,
  };
  await fs.writeFile(file, JSON.stringify(envelope), "utf8");
}

/** Avoid flooding Render logs when Upstash is flaky (rate limit / network). */
let redisFailLogAt = 0;
let redisFailCount = 0;

function logRedisFail(event: string, key: string, err: unknown): void {
  redisFailCount += 1;
  const now = Date.now();
  // Log first failure immediately, then at most once per 30s with count
  if (now - redisFailLogAt < 30_000 && redisFailCount > 1) return;
  redisFailLogAt = now;
  console.warn(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      event,
      key,
      err: err instanceof Error ? err.message : String(err),
      recentFails: redisFailCount,
    }),
  );
  redisFailCount = 0;
}

async function redisGet<T>(key: string, ttlMs: number): Promise<T | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const parsed = (await r.get(redisKey(key))) as CacheEnvelope<T> | null;
    if (!parsed?.savedAt || parsed.data === undefined) return null;
    // Honor caller TTL even if Redis EX was longer
    if (Date.now() - parsed.savedAt > ttlMs) return null;
    return parsed.data;
  } catch (err) {
    logRedisFail("redis_get_failed", key, err);
    return null;
  }
}

async function redisSet<T>(
  key: string,
  data: T,
  ttlMs: number,
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    const envelope: CacheEnvelope<T> = {
      savedAt: Date.now(),
      data,
      ttlMs,
    };
    const exSec = Math.max(60, Math.ceil(ttlMs / 1000));
    await r.set(redisKey(key), envelope, { ex: exSec });
  } catch (err) {
    logRedisFail("redis_set_failed", key, err);
  }
}

/**
 * Read cache entry. Prefers Redis (shared), falls back to local disk.
 */
export async function cacheGet<T>(
  key: string,
  ttlMs = DEFAULT_TTL_MS,
): Promise<T | null> {
  // Shared cache first (survives Render sleep; shared by all users)
  const fromRedis = await redisGet<T>(key, ttlMs);
  if (fromRedis != null) return fromRedis;

  // Local disk (dev / warm free dyno)
  return diskGet<T>(key, ttlMs);
}

/**
 * Write cache entry. Writes Redis when configured, always tries disk too
 * so local tooling and dual-mode deploys stay consistent.
 */
export async function cacheSet<T>(
  key: string,
  data: T,
  ttlMs = DEFAULT_TTL_MS,
): Promise<void> {
  await Promise.all([
    redisSet(key, data, ttlMs),
    diskSet(key, data, ttlMs).catch((err) => {
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          event: "cache_write_failed",
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }),
  ]);
}
