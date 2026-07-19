import { cacheGet, cacheSet } from "./cache.js";
import { getSamApiKey } from "./env.js";
import { log } from "./logger.js";
import { createThrottle, sleep } from "./throttle.js";

/**
 * SAM.gov Entity Information API (v3).
 * Uses SAM_API_KEY from env (Account Details key, not Data.gov).
 *
 * Free/public keys are heavily rate-limited (often daily quota). We:
 *  - cache successes 24h
 *  - serialize + space out live requests
 *  - retry transient 429s with backoff
 *  - circuit-break when SAM returns a daily quota / nextAccessTime
 */

export interface SamEntitySummary {
  uei: string;
  found: boolean;
  excluded: boolean;
  exclusionCount: number;
  registrationDate: string | null;
  registrationAgeDays: number | null;
  registrationStatus: string | null;
  /** 0–100 risk from SAM registration age + exclusions. */
  riskScore: number;
  legalBusinessName: string | null;
}

export type SamLookup =
  | { status: "ok"; data: SamEntitySummary }
  | { status: "error"; message: string }
  | { status: "skipped" };

/** ~1.2s between live SAM calls (global process queue). */
const samThrottle = createThrottle(1200);

/** When set, skip all live SAM calls until this timestamp (ms). */
let samQuotaBlockedUntil = 0;

const MAX_RETRIES_429 = 3;

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}

function ageRisk(days: number | null): number {
  if (days == null) return 0;
  if (days < 90) return 70;
  if (days < 180) return 50;
  if (days < 365) return 30;
  if (days < 730) return 12;
  return 0;
}

function isExcludedFlag(v: unknown): boolean {
  if (v === true) return true;
  const s = String(v ?? "")
    .trim()
    .toUpperCase();
  return s === "Y" || s === "YES" || s === "TRUE" || s === "1";
}

function parseQuotaBlock(body: string, retryAfterHeader: string | null): number | null {
  // e.g. nextAccessTime":"2026-Jul-20 00:00:00+0000 UTC"
  const next =
    body.match(/nextAccessTime["']?\s*:\s*["']([^"']+)["']/i)?.[1] ??
    body.match(/after\s+(\d{4}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2}:\d{2}[^\s"]*)/i)?.[1];
  if (next) {
    // Normalize "2026-Jul-20 00:00:00+0000 UTC" → something Date can parse
    const normalized = next
      .replace(/\+0000\s*UTC/i, "Z")
      .replace(
        /(\d{4})-([A-Za-z]{3})-(\d{2})/,
        (_, y, mon, d) => {
          const months: Record<string, string> = {
            Jan: "01",
            Feb: "02",
            Mar: "03",
            Apr: "04",
            May: "05",
            Jun: "06",
            Jul: "07",
            Aug: "08",
            Sep: "09",
            Oct: "10",
            Nov: "11",
            Dec: "12",
          };
          return `${y}-${months[mon] ?? "01"}-${d}`;
        },
      );
    const t = Date.parse(normalized);
    if (Number.isFinite(t) && t > Date.now()) return t;
  }
  if (retryAfterHeader) {
    const sec = Number(retryAfterHeader);
    if (Number.isFinite(sec) && sec > 0) {
      return Date.now() + sec * 1000;
    }
  }
  // Daily-style throttle without parseable time → block 1 hour as soft backoff
  if (/quota|throttled|exceeded/i.test(body)) {
    return Date.now() + 60 * 60 * 1000;
  }
  return null;
}

export function getSamQuotaStatus(): {
  blocked: boolean;
  until: number | null;
} {
  if (Date.now() < samQuotaBlockedUntil) {
    return { blocked: true, until: samQuotaBlockedUntil };
  }
  return { blocked: false, until: null };
}

function emptySummary(uei: string): SamEntitySummary {
  return {
    uei,
    found: false,
    excluded: false,
    exclusionCount: 0,
    registrationDate: null,
    registrationAgeDays: null,
    registrationStatus: null,
    riskScore: 0,
    legalBusinessName: null,
  };
}

function summaryFromEntity(
  clean: string,
  entity: {
    entityRegistration?: {
      ueiSAM?: string;
      legalBusinessName?: string;
      registrationDate?: string;
      registrationStatus?: string;
      exclusionStatusFlag?: string | boolean;
      ueiStatus?: string;
    };
  },
): SamEntitySummary {
  const reg = entity.entityRegistration;
  if (!reg) return emptySummary(clean);

  const regDate = reg.registrationDate ?? null;
  const age = daysSince(regDate);
  const excluded = isExcludedFlag(reg.exclusionStatusFlag);
  const exclusionCount = excluded ? 1 : 0;

  let riskScore = ageRisk(age);
  if (excluded) riskScore = Math.min(100, riskScore + 85);

  return {
    uei: clean,
    found: true,
    excluded,
    exclusionCount,
    registrationDate: regDate,
    registrationAgeDays: age,
    registrationStatus: reg.registrationStatus ?? reg.ueiStatus ?? null,
    riskScore: Math.min(100, riskScore),
    legalBusinessName: reg.legalBusinessName ?? null,
  };
}

async function samFetchOnce(
  apiKey: string,
  clean: string,
): Promise<Response> {
  const url =
    `https://api.sam.gov/entity-information/v3/entities` +
    `?api_key=${encodeURIComponent(apiKey)}` +
    `&ueiSAM=${encodeURIComponent(clean)}` +
    `&includeSections=entityRegistration,coreData`;

  return fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(25000),
  });
}

/**
 * Live SAM lookup with global throttle + 429 retries.
 * Must only be called for uncached UEIs.
 */
async function fetchSamLive(
  apiKey: string,
  clean: string,
): Promise<SamLookup> {
  if (Date.now() < samQuotaBlockedUntil) {
    const until = new Date(samQuotaBlockedUntil).toISOString();
    return {
      status: "error",
      message: `SAM daily quota exceeded, retry after ${until}`,
    };
  }

  return samThrottle(async () => {
    // Re-check after waiting in queue
    if (Date.now() < samQuotaBlockedUntil) {
      const until = new Date(samQuotaBlockedUntil).toISOString();
      return {
        status: "error" as const,
        message: `SAM daily quota exceeded, retry after ${until}`,
      };
    }

    for (let attempt = 0; attempt <= MAX_RETRIES_429; attempt++) {
      try {
        const res = await samFetchOnce(apiKey, clean);

        if (res.status === 429) {
          const text = await res.text().catch(() => "");
          const retryAfter = res.headers.get("retry-after");
          const blockUntil = parseQuotaBlock(text, retryAfter);

          // Hard daily quota → circuit break
          if (
            blockUntil &&
            blockUntil - Date.now() > 5 * 60 * 1000 // >5 min = treat as quota
          ) {
            samQuotaBlockedUntil = blockUntil;
            log.warn("sam_quota_blocked", {
              uei: clean,
              until: new Date(blockUntil).toISOString(),
            });
            return {
              status: "error" as const,
              message: `SAM daily quota exceeded, retry after ${new Date(blockUntil).toISOString()}`,
            };
          }

          const waitMs = blockUntil
            ? Math.min(blockUntil - Date.now(), 30_000)
            : Math.min(1000 * 2 ** attempt, 15_000);

          log.warn("sam_429_retry", {
            uei: clean,
            attempt,
            waitMs,
          });

          if (attempt === MAX_RETRIES_429) {
            return {
              status: "error" as const,
              message: "SAM HTTP 429 (rate limited)",
            };
          }
          await sleep(Math.max(waitMs, 1500));
          continue;
        }

        if (!res.ok) {
          log.warn("sam_http_error", { uei: clean, status: res.status });
          if (res.status === 401 || res.status === 403) {
            return {
              status: "error" as const,
              message: `SAM HTTP ${res.status} (key expired or invalid, regenerate on SAM Account Details)`,
            };
          }
          return {
            status: "error" as const,
            message: `SAM HTTP ${res.status}`,
          };
        }

        const data = (await res.json()) as {
          entityData?: Array<{
            entityRegistration?: {
              ueiSAM?: string;
              legalBusinessName?: string;
              registrationDate?: string;
              registrationStatus?: string;
              exclusionStatusFlag?: string | boolean;
              ueiStatus?: string;
            };
            coreData?: unknown;
          }>;
        };

        const entity = data.entityData?.[0];
        const summary = entity
          ? summaryFromEntity(clean, entity)
          : emptySummary(clean);

        await cacheSet(`sam_${clean}`, summary);
        return { status: "ok" as const, data: summary };
      } catch (err) {
        if (attempt < MAX_RETRIES_429) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        log.warn("sam_error", { uei: clean, err });
        return {
          status: "error" as const,
          message: err instanceof Error ? err.message : "SAM request failed",
        };
      }
    }

    return { status: "error" as const, message: "SAM request failed" };
  });
}

export async function fetchSamByUei(uei: string): Promise<SamLookup> {
  const apiKey = getSamApiKey();
  if (!apiKey || !uei?.trim()) return { status: "skipped" };

  const clean = uei.trim().toUpperCase();
  const cacheKey = `sam_${clean}`;
  const cached = await cacheGet<SamEntitySummary>(cacheKey, 24 * 60 * 60 * 1000);
  if (cached) return { status: "ok", data: cached };

  if (Date.now() < samQuotaBlockedUntil) {
    const until = new Date(samQuotaBlockedUntil).toISOString();
    return {
      status: "error",
      message: `SAM daily quota exceeded, retry after ${until}`,
    };
  }

  return fetchSamLive(apiKey, clean);
}
