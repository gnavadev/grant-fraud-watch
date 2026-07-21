/**
 * Slim list/API payloads for Redis page cache (Upstash free ≤10MB / request).
 */
import type { Facility, FacilitiesResponse } from "./types.js";

/** Drop heavy chart/debug fields not needed for table + deep-dive rescore. */
export function slimFacilityForCache(f: Facility): Facility {
  const amounts = f.rescore?.scoreAmounts ?? [];
  // Cap amount list so one org cannot blow the page payload
  const scoreAmounts =
    amounts.length > 80 ? amounts.slice(0, 80) : amounts;

  return {
    id: f.id,
    name: f.name,
    city: f.city,
    county: f.county,
    state: f.state,
    grantReceived: f.grantReceived,
    awardCount: f.awardCount,
    grantsHydrated: f.grantsHydrated,
    sampleCount: f.sampleCount,
    fraudChance: f.fraudChance,
    fraudLabel: f.fraudLabel,
    confidence: f.confidence,
    scoreMethod: f.scoreMethod,
    scoreStatus: f.scoreStatus,
    failReasons: f.failReasons,
    benfordScore: f.benfordScore,
    multiScore: f.multiScore,
    signals: f.signals,
    avgAward: f.avgAward,
    primaryCfda: f.primaryCfda,
    awardTypes: f.awardTypes,
    uei: f.uei,
    recipientId: f.recipientId,
    benfordEligible: f.benfordEligible,
    enrichment: f.enrichment,
    rescore: f.rescore
      ? {
          scoreAmounts,
          awardTypes: f.rescore.awardTypes,
          usedTransactions: f.rescore.usedTransactions,
          primaryCfda: f.rescore.primaryCfda,
          grantReceived: f.rescore.grantReceived,
          awardCount: f.rescore.awardCount,
        }
      : undefined,
    // Minimal stubs so type stays valid; deep dive can recompute charts
    benford: f.benford,
    features: f.features,
    deepScored: f.deepScored,
  };
}

export function slimFacilitiesResponse(
  body: FacilitiesResponse,
): FacilitiesResponse {
  return {
    ...body,
    facilities: body.facilities.map(slimFacilityForCache),
  };
}
