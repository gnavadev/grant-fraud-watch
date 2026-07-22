import { cacheGet, cacheSet } from "./cache.js";
import { getSamApiKey } from "./env.js";
import { log } from "./logger.js";
import {
  ensureSamExclusionsIndex,
  getSamExtractStatus,
  isUeiExcluded,
} from "./samExtract.js";
import {
  ensureSamEntityIndex,
  getEntityFromExtract,
} from "./samEntityExtract.js";
import { createThrottle, sleep } from "./throttle.js";

/**
 * SAM risk data for a UEI.
 *
 * Primary path (avoids 10/day Entity API burn):
 *   1) Public exclusions extract → local UEI set (1 download/day)
 *   2) Public monthly entity extract → SQLite (registration age / name)
 *        built via `npm run sam:sync` (not per search)
 *
 * Optional live Entity API only when SAM_LIVE_FALLBACK=1.
 */

export interface SamEntitySummary {
  uei: string;
  found: boolean;
  excluded: boolean;
  exclusionCount: number;
  registrationDate: string | null;
  registrationAgeDays: number | null;
  registrationStatus: string | null;
  /** 0-100 risk from SAM registration age + exclusions. */
  riskScore: number;
  legalBusinessName: string | null;
  /** How we resolved this row. */
  source?: "extract" | "live" | "cache" | "none";
}

export type SamLookup =
  | { status: "ok"; data: SamEntitySummary }
  | { status: "error"; message: string }
  | { status: "skipped" };

const samThrottle = createThrottle(1200);
let samQuotaBlockedUntil = 0;
const MAX_RETRIES_429 = 3;

function liveFallbackEnabled(): boolean {
  const v = (process.env.SAM_LIVE_FALLBACK ?? "0").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

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

function parseQuotaBlock(
  body: string,
  retryAfterHeader: string | null,
): number | null {
  const next =
    body.match(/nextAccessTime["']?\s*:\s*["']([^"']+)["']/i)?.[1] ??
    body.match(
      /after\s+(\d{4}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2}:\d{2}[^\s"]*)/i,
    )?.[1];
  if (next) {
    const normalized = next
      .replace(/\+0000\s*UTC/i, "Z")
      .replace(/(\d{4})-([A-Za-z]{3})-(\d{2})/, (_, y, mon, d) => {
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
      });
    const t = Date.parse(normalized);
    if (Number.isFinite(t) && t > Date.now()) return t;
  }
  if (retryAfterHeader) {
    const sec = Number(retryAfterHeader);
    if (Number.isFinite(sec) && sec > 0) return Date.now() + sec * 1000;
  }
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

export { getSamExtractStatus };

function emptySummary(
  uei: string,
  source: SamEntitySummary["source"] = "none",
): SamEntitySummary {
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
    source,
  };
}

function summaryFromLiveEntity(
  clean: string,
  entity: {
    entityRegistration?: {
      legalBusinessName?: string;
      registrationDate?: string;
      registrationStatus?: string;
      exclusionStatusFlag?: string | boolean;
      ueiStatus?: string;
    };
  },
  extractExcluded: boolean | null,
): SamEntitySummary {
  const reg = entity.entityRegistration;
  if (!reg) {
    const s = emptySummary(clean, "live");
    if (extractExcluded) {
      s.found = true;
      s.excluded = true;
      s.exclusionCount = 1;
      s.riskScore = 85;
    }
    return s;
  }

  const regDate = reg.registrationDate ?? null;
  const age = daysSince(regDate);
  const flagExcluded = isExcludedFlag(reg.exclusionStatusFlag);
  const excluded = extractExcluded === true || flagExcluded;
  const liveStatus = (reg.registrationStatus ?? "").trim().toUpperCase();
  // Live path: only treat as publicly "found" when registration is Active (or excluded)
  const isActive =
    liveStatus === "A" ||
    liveStatus === "ACTIVE" ||
    liveStatus === "ACTIVE REGISTRATION";
  const publicDisplay = String(
    (reg as { publicDisplayFlag?: string }).publicDisplayFlag ?? "Y",
  )
    .trim()
    .toUpperCase();
  const displayOk = publicDisplay !== "N" && publicDisplay !== "NPDY";

  let riskScore = isActive ? ageRisk(age) : 0;
  if (excluded) riskScore = Math.min(100, riskScore + 85);

  return {
    uei: clean,
    found: (isActive && displayOk) || excluded,
    excluded,
    exclusionCount: excluded ? 1 : 0,
    registrationDate: isActive ? regDate : null,
    registrationAgeDays: isActive ? age : null,
    registrationStatus: reg.registrationStatus ?? reg.ueiStatus ?? null,
    riskScore: Math.min(100, riskScore),
    legalBusinessName: reg.legalBusinessName ?? null,
    source: "live",
  };
}

async function fetchSamLive(
  apiKey: string,
  clean: string,
  extractExcluded: boolean | null,
): Promise<SamLookup> {
  if (Date.now() < samQuotaBlockedUntil) {
    return {
      status: "error",
      message: `SAM daily quota exceeded, retry after ${new Date(samQuotaBlockedUntil).toISOString()}`,
    };
  }

  return samThrottle(async () => {
    if (Date.now() < samQuotaBlockedUntil) {
      return {
        status: "error" as const,
        message: `SAM daily quota exceeded, retry after ${new Date(samQuotaBlockedUntil).toISOString()}`,
      };
    }

    const url =
      `https://api.sam.gov/entity-information/v3/entities` +
      `?api_key=${encodeURIComponent(apiKey)}` +
      `&ueiSAM=${encodeURIComponent(clean)}` +
      `&includeSections=entityRegistration,coreData`;

    for (let attempt = 0; attempt <= MAX_RETRIES_429; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(25000),
        });

        if (res.status === 429) {
          const text = await res.text().catch(() => "");
          const blockUntil = parseQuotaBlock(text, res.headers.get("retry-after"));
          if (blockUntil && blockUntil - Date.now() > 5 * 60 * 1000) {
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
          if (attempt === MAX_RETRIES_429) {
            return {
              status: "error" as const,
              message: "SAM HTTP 429 (rate limited)",
            };
          }
          await sleep(Math.max(blockUntil ? blockUntil - Date.now() : 2000, 1500));
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
              legalBusinessName?: string;
              registrationDate?: string;
              registrationStatus?: string;
              exclusionStatusFlag?: string | boolean;
              ueiStatus?: string;
            };
          }>;
        };

        const entity = data.entityData?.[0];
        const summary = entity
          ? summaryFromLiveEntity(clean, entity, extractExcluded)
          : (() => {
              const s = emptySummary(clean, "live");
              if (extractExcluded) {
                s.found = true;
                s.excluded = true;
                s.exclusionCount = 1;
                s.riskScore = 85;
              }
              return s;
            })();

        await cacheSet(`sam_${clean}`, summary, 24 * 60 * 60 * 1000);
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

let extractsReadyPromise: Promise<void> | null = null;

/** Load SAM extracts once per process wave (not once per UEI). */
export async function ensureSamExtractsReady(): Promise<void> {
  if (!extractsReadyPromise) {
    extractsReadyPromise = (async () => {
      await ensureSamExclusionsIndex();
      await ensureSamEntityIndex();
    })().catch((err) => {
      extractsReadyPromise = null;
      throw err;
    });
  }
  await extractsReadyPromise;
}

function todayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Active on public extract only if status A/Active and expiration not past. */
function isCurrentlyActiveRegistration(entity: {
  registrationStatus: string | null;
  expirationDate: string | null;
} | null): boolean {
  if (!entity) return false;
  const status = (entity.registrationStatus ?? "").trim().toUpperCase();
  if (status !== "A" && status !== "ACTIVE") return false;
  const exp = (entity.expirationDate ?? "").trim();
  if (exp && exp < todayIsoUtc()) return false;
  return true;
}

function summaryFromExtracts(clean: string): SamEntitySummary {
  const extractExcluded = isUeiExcluded(clean);
  const entityRow = getEntityFromExtract(clean);
  const excluded = extractExcluded === true;
  const isActive = isCurrentlyActiveRegistration(entityRow);
  const regDate = entityRow?.registrationDate ?? null;
  const age = daysSince(regDate);
  // Align with bulk: public SAM links only for currently Active or exclusions
  let riskScore = isActive ? ageRisk(age) : 0;
  if (excluded) riskScore = Math.min(100, riskScore + 85);

  return {
    uei: clean,
    found: isActive || excluded,
    excluded,
    exclusionCount: excluded ? 1 : 0,
    registrationDate: isActive ? regDate : null,
    registrationAgeDays: isActive ? age : null,
    registrationStatus: isActive
      ? entityRow?.registrationStatus ?? "A"
      : entityRow?.registrationStatus ?? null,
    riskScore: Math.min(100, riskScore),
    legalBusinessName: entityRow?.legalBusinessName ?? null,
    source: "extract",
  };
}

/**
 * Resolve SAM risk for a UEI using exclusions extract first (no per-UEI quota burn).
 * Extract path is local (no Redis per UEI) so list pages stay fast.
 */
export async function fetchSamByUei(uei: string): Promise<SamLookup> {
  // API key only required for optional live fallback; extracts work without it
  if (!uei?.trim()) return { status: "skipped" };

  const clean = uei.trim().toUpperCase();
  const cacheKey = `sam_${clean}`;
  const samTtl = 24 * 60 * 60 * 1000;

  // Default path: local extracts only (no live Entity API, no Redis per UEI)
  if (!liveFallbackEnabled()) {
    try {
      await ensureSamExtractsReady();
      return { status: "ok", data: summaryFromExtracts(clean) };
    } catch (err) {
      log.warn("sam_extract_lookup_failed", { uei: clean, err });
      return {
        status: "error",
        message: err instanceof Error ? err.message : "SAM extract failed",
      };
    }
  }

  const apiKey = getSamApiKey();
  if (!apiKey) return { status: "skipped" };

  const cached = await cacheGet<SamEntitySummary>(cacheKey, samTtl);
  if (cached) {
    return { status: "ok", data: { ...cached, source: cached.source ?? "cache" } };
  }

  await ensureSamExtractsReady();
  const extractExcluded = isUeiExcluded(clean);

  // Optional live enrichment (registration age) when explicitly enabled
  if (Date.now() < samQuotaBlockedUntil) {
    // Still return extract exclusion result
    if (extractExcluded === true) {
      return {
        status: "ok",
        data: {
          uei: clean,
          found: true,
          excluded: true,
          exclusionCount: 1,
          registrationDate: null,
          registrationAgeDays: null,
          registrationStatus: null,
          riskScore: 85,
          legalBusinessName: null,
          source: "extract",
        },
      };
    }
    return {
      status: "error",
      message: `SAM daily quota exceeded, retry after ${new Date(samQuotaBlockedUntil).toISOString()}`,
    };
  }

  return fetchSamLive(apiKey, clean, extractExcluded);
}
