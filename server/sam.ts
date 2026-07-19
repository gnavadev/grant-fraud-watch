import { cacheGet, cacheSet } from "./cache.js";
import { getSamApiKey } from "./env.js";

/**
 * SAM.gov Entity Information API (v3).
 * Uses SAM_API_KEY from env (Account Details key, not Data.gov).
 *
 * Valid includeSections for registered entities:
 *   entityRegistration, coreData, assertions, pointsOfContact,
 *   repsAndCerts, integrityInformation, All
 * Invalid (returns HTTP 400): exclusions, entityList
 * Exclusion status is on entityRegistration.exclusionStatusFlag.
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

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}

function ageRisk(days: number | null): number {
  if (days == null) return 0;
  // Registered very recently before/during large awards is a shell signal
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

export type SamLookup =
  | { status: "ok"; data: SamEntitySummary }
  | { status: "error"; message: string }
  | { status: "skipped" };

export async function fetchSamByUei(uei: string): Promise<SamLookup> {
  const apiKey = getSamApiKey();
  if (!apiKey || !uei?.trim()) return { status: "skipped" };

  const clean = uei.trim().toUpperCase();
  const cacheKey = `sam_${clean}`;
  const cached = await cacheGet<SamEntitySummary>(cacheKey, 24 * 60 * 60 * 1000);
  if (cached) return { status: "ok", data: cached };

  // Match the official Entity API shape the website documents / curl examples use.
  // Do NOT request "exclusions" or "entityList" as includeSections — those 400.
  const url =
    `https://api.sam.gov/entity-information/v3/entities` +
    `?api_key=${encodeURIComponent(apiKey)}` +
    `&ueiSAM=${encodeURIComponent(clean)}` +
    `&includeSections=entityRegistration,coreData`;

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[sam]", clean, res.status, text.slice(0, 200));
      return { status: "error", message: `SAM HTTP ${res.status}` };
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
      totalRecords?: number;
    };

    const entity = data.entityData?.[0];
    if (!entity?.entityRegistration) {
      const empty: SamEntitySummary = {
        uei: clean,
        found: false,
        excluded: false,
        exclusionCount: 0,
        registrationDate: null,
        registrationAgeDays: null,
        registrationStatus: null,
        riskScore: 0,
        legalBusinessName: null,
      };
      await cacheSet(cacheKey, empty);
      return { status: "ok", data: empty };
    }

    const reg = entity.entityRegistration;
    const regDate = reg.registrationDate ?? null;
    const age = daysSince(regDate);
    const excluded = isExcludedFlag(reg.exclusionStatusFlag);
    const exclusionCount = excluded ? 1 : 0;

    let riskScore = ageRisk(age);
    if (excluded) riskScore = Math.min(100, riskScore + 85);

    const summary: SamEntitySummary = {
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
    await cacheSet(cacheKey, summary);
    return { status: "ok", data: summary };
  } catch (err) {
    console.warn("[sam] error", clean, err);
    return {
      status: "error",
      message: err instanceof Error ? err.message : "SAM request failed",
    };
  }
}
