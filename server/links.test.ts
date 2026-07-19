/**
 * Client link rules (run via tsx; imports client TS).
 * Ensures FAC only links when reportId exists; no CFDA FAL URLs.
 */
import { facilityLinks } from "../client/src/lib/links.ts";
import type { Facility } from "../client/src/types.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function baseFacility(over: Partial<Facility> = {}): Facility {
  return {
    id: "rec-1",
    name: "Test Org",
    city: "Houston",
    county: "Harris",
    state: "TX",
    grantReceived: 1_000_000,
    awardCount: 5,
    sampleCount: 5,
    fraudChance: 40,
    fraudLabel: "medium",
    confidence: "low",
    scoreMethod: "statistical",
    benfordScore: null,
    multiScore: 40,
    uei: "GN32L2K6ZE88",
    recipientId: "rec-1",
    primaryCfda: "93.600",
    benford: {
      sampleSize: 5,
      chiSquare: null,
      digitCounts: {},
      minFullSample: 50,
      minLowSample: 1,
    },
    features: {
      n: 5,
      sum: 0,
      mean: 0,
      std: 0,
      median: 0,
      min: 0,
      max: 0,
      cv: 0,
      maxToMean: 0,
      pctRound: 0,
      pctNegative: 0,
      logSum: 0,
      logMean: 0,
      digitEntropy: 0,
      benfordMad: 0,
      benfordChi: 0,
    },
    ...over,
  };
}

// FAC with report → summary + PDF available
const withFac = baseFacility({
  enrichment: {
    fac: {
      found: true,
      riskScore: 10,
      findingsCount: 0,
      materialWeakness: false,
      goingConcern: false,
      lowRiskAuditee: true,
      reportId: "2025-06-GSAFAC-0000409652",
      auditYear: 2025,
    },
    sam: {
      found: true,
      riskScore: 0,
      excluded: false,
      registrationAgeDays: 1000,
    },
  },
});
const linksFac = facilityLinks(withFac);
const facSummary = linksFac.find((l) => l.label.includes("FAC Single Audit summary"));
assert(facSummary?.available === true, "FAC summary available");
assert(
  facSummary?.href?.includes("/dissemination/summary/2025-06-GSAFAC-0000409652") ===
    true,
  "FAC summary uses report id",
);
assert(
  linksFac.every((l) => !l.href?.includes("/fal/")),
  "no SAM FAL CFDA links",
);

// No FAC → grayed, not a paste-UEI search
const noFac = baseFacility({
  enrichment: {
    fac: {
      found: false,
      riskScore: 0,
      findingsCount: 0,
      materialWeakness: false,
      goingConcern: false,
      lowRiskAuditee: true,
      reportId: null,
    },
    sam: { found: false, riskScore: 0, excluded: false, registrationAgeDays: null },
  },
});
const linksNo = facilityLinks(noFac);
const facDisabled = linksNo.find((l) => l.label.startsWith("FAC"));
assert(facDisabled?.available === false, "FAC disabled without report");
assert(facDisabled?.href == null, "no FAC href without report");
assert(
  !linksNo.some((l) => l.label.toLowerCase().includes("paste")),
  "no paste UEI link",
);

// SAM found vs not
const samOk = linksFac.find((l) => l.label.includes("SAM.gov entity"));
assert(samOk?.available === true, "SAM available when found");
const samNo = linksNo.find((l) => l.label.startsWith("SAM.gov entity"));
assert(samNo?.available === false, "SAM grayed when not found");

console.log("links tests passed");
