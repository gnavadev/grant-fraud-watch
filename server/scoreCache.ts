/**
 * Compact facility → fraud-chance map in Redis (and disk fallback via cache.ts).
 *
 * Much smaller than full page responses: one key per org, reusable across
 * searches/pages. Upstash Data Browser will show many `gfw:sc:…` keys when working.
 */
import { cacheGet, cacheSet } from "./cache.js";
import type {
  Facility,
  FraudLabel,
  ScoreConfidence,
  ScoreMethod,
  SignalBreakdown,
} from "./types.js";

const SCORE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const KEY_PREFIX = "sc:v1:";

/** Compact score row stored in Redis. */
export interface FacilityScoreEntry {
  id: string;
  uei: string | null;
  name: string;
  fraudChance: number | null;
  fraudLabel: FraudLabel;
  confidence: ScoreConfidence;
  scoreMethod: ScoreMethod;
  multiScore: number | null;
  benfordScore: number | null;
  signals?: SignalBreakdown;
  grantReceived: number;
  awardCount: number;
  grantsHydrated?: boolean;
  sampleCount: number;
  /** Rough fingerprint so we rescore if the search sample changed a lot. */
  fp: string;
  scoredAt: number;
  enrichment?: Facility["enrichment"];
  avgAward?: number | null;
  primaryCfda?: string | null;
}

export function scoreFingerprint(
  grantReceived: number,
  awardCount: number,
): string {
  return `${awardCount}:${Math.round(grantReceived)}`;
}

function scoreKey(facilityId: string): string {
  // Keep key short; hash long name: ids
  const id = facilityId.trim();
  if (id.length <= 80) return `${KEY_PREFIX}${id}`;
  return `${KEY_PREFIX}${Buffer.from(id).toString("base64url").slice(0, 64)}`;
}

export async function getFacilityScore(
  facilityId: string,
): Promise<FacilityScoreEntry | null> {
  if (!facilityId) return null;
  return cacheGet<FacilityScoreEntry>(scoreKey(facilityId), SCORE_TTL_MS);
}

export async function getFacilityScores(
  facilityIds: string[],
): Promise<Map<string, FacilityScoreEntry>> {
  const map = new Map<string, FacilityScoreEntry>();
  const unique = [...new Set(facilityIds.filter(Boolean))];
  // Modest concurrency so Upstash free tier is not hammered
  const concurrency = 8;
  let i = 0;
  async function worker() {
    while (i < unique.length) {
      const idx = i++;
      const id = unique[idx];
      const row = await getFacilityScore(id);
      if (row) map.set(id, row);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()),
  );
  return map;
}

export async function setFacilityScore(entry: FacilityScoreEntry): Promise<void> {
  await cacheSet(scoreKey(entry.id), entry, SCORE_TTL_MS);
}

/** Batch-write scores (precalc / list). Concurrency limited for Upstash free tier. */
export async function persistFacilityScores(
  facilities: Facility[],
  concurrency = 6,
): Promise<number> {
  const rows = facilities
    .filter((f) => f.id && f.scoreStatus !== "failed")
    .map(facilityToScoreEntry);
  if (rows.length === 0) return 0;

  let i = 0;
  let written = 0;
  async function worker() {
    while (i < rows.length) {
      const idx = i++;
      await setFacilityScore(rows[idx]);
      written += 1;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()),
  );
  return written;
}

export function facilityToScoreEntry(f: Facility): FacilityScoreEntry {
  // Keep small for Upstash free 10MB request limit (many SETs, each tiny)
  return {
    id: f.id,
    uei: f.uei ?? null,
    name: f.name,
    fraudChance: f.fraudChance,
    fraudLabel: f.fraudLabel,
    confidence: f.confidence,
    scoreMethod: f.scoreMethod,
    multiScore: f.multiScore ?? null,
    benfordScore: f.benfordScore,
    signals: f.signals,
    grantReceived: f.grantReceived,
    awardCount: f.awardCount,
    grantsHydrated: f.grantsHydrated,
    sampleCount: f.sampleCount,
    fp: scoreFingerprint(f.grantReceived, f.awardCount),
    scoredAt: Date.now(),
    enrichment: f.enrichment
      ? {
          fac: f.enrichment.fac
            ? {
                found: f.enrichment.fac.found,
                riskScore: f.enrichment.fac.riskScore,
                findingsCount: f.enrichment.fac.findingsCount,
                materialWeakness: f.enrichment.fac.materialWeakness,
                goingConcern: f.enrichment.fac.goingConcern,
                lowRiskAuditee: f.enrichment.fac.lowRiskAuditee,
                reportId: f.enrichment.fac.reportId ?? null,
                auditYear: f.enrichment.fac.auditYear ?? null,
              }
            : null,
          sam: f.enrichment.sam
            ? {
                found: f.enrichment.sam.found,
                riskScore: f.enrichment.sam.riskScore,
                excluded: f.enrichment.sam.excluded,
                registrationAgeDays: f.enrichment.sam.registrationAgeDays,
                legalBusinessName: f.enrichment.sam.legalBusinessName ?? null,
              }
            : null,
          subaward: f.enrichment.subaward ?? null,
          temporal: f.enrichment.temporal ?? null,
        }
      : undefined,
    avgAward: f.avgAward,
    primaryCfda: f.primaryCfda,
  };
}

/**
 * True if cached score is still usable for this sample (amounts roughly same).
 */
export function scoreEntryStillValid(
  entry: FacilityScoreEntry,
  grantReceived: number,
  awardCount: number,
): boolean {
  if (Date.now() - entry.scoredAt > SCORE_TTL_MS) return false;
  const fp = scoreFingerprint(grantReceived, awardCount);
  if (entry.fp === fp) return true;
  // Allow small drift (new award in sample)
  const oldG = entry.grantReceived || 1;
  const ratio = grantReceived / oldG;
  if (ratio >= 0.7 && ratio <= 1.4 && Math.abs(awardCount - entry.awardCount) <= 3) {
    return true;
  }
  return false;
}

/** Apply cached score fields onto a freshly built facility row (list display). */
export function applyScoreEntry(f: Facility, entry: FacilityScoreEntry): Facility {
  return {
    ...f,
    fraudChance: entry.fraudChance,
    fraudLabel: entry.fraudLabel,
    confidence: entry.confidence,
    scoreMethod: entry.scoreMethod,
    multiScore: entry.multiScore,
    benfordScore: entry.benfordScore,
    signals: entry.signals ?? f.signals,
    scoreStatus: "ok",
    enrichment: entry.enrichment ?? f.enrichment,
    avgAward: entry.avgAward ?? f.avgAward,
    primaryCfda: entry.primaryCfda ?? f.primaryCfda,
    // Prefer hydrated counts from cache when present
    awardCount: entry.grantsHydrated ? entry.awardCount : f.awardCount,
    grantsHydrated: entry.grantsHydrated || f.grantsHydrated,
    sampleCount: entry.sampleCount || f.sampleCount,
  };
}
