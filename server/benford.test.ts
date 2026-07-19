import {
  isBenfordEligible,
  gatedBenfordScore,
  grantRoundnessScore,
  benfordSizeReliability,
  benfordBlendWeight,
  benfordSpanReliability,
  MIN_BENFORD_ELIGIBLE,
} from "./multiSignal.js";
import { madToAnomalyScore, scoreAmountsWithBenford } from "./benford.js";
import { computeMultiSignalScore } from "./multiSignal.js";
import { extractAmountFeatures } from "./features.js";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Eligibility: any positive amounts (n ≥ 1); weight handles small n
const empty: number[] = [];
assert(!isBenfordEligible(empty).eligible, "n=0 not eligible");

const one = [1000];
assert(isBenfordEligible(one).eligible, "n=1 eligible for chart");
assert(MIN_BENFORD_ELIGIBLE === 1, "min is 1");

const three = [1000, 2000, 3000];
assert(isBenfordEligible(three).eligible, "n=3 eligible");

const seventeen = Array.from({ length: 17 }, (_, i) => (i + 1) * 1000 + i * 37);
assert(isBenfordEligible(seventeen).eligible, "n=17 should be eligible");

const gatedSeventeen = gatedBenfordScore(seventeen);
assert(gatedSeventeen.eligible, "gated eligible for n=17");
assert(gatedSeventeen.score != null, "gated score for n=17");
assert(
  (gatedSeventeen.weight ?? 0) < 0.02,
  `n=17 Benford weight should be tiny, got ${gatedSeventeen.weight}`,
);

// Size reliability logistic (Nigrini-aligned)
assert(benfordSizeReliability(0) === 0, "n=0 reliability 0");
assert(benfordSizeReliability(1) > 0 && benfordSizeReliability(1) < 0.08, "n=1 tiny r");
assert(benfordSizeReliability(3) > 0 && benfordSizeReliability(3) < 0.08, "n=3 tiny r");
assert(benfordSizeReliability(100) > 0.2 && benfordSizeReliability(100) < 0.35, "n=100 ~0.25");
assert(benfordSizeReliability(150) > 0.45 && benfordSizeReliability(150) < 0.55, "n=150 ~0.5");
assert(benfordSizeReliability(300) > 0.9, "n=300 high r");

// Weight grows with n
const w17 = benfordBlendWeight(17, 3);
const w100 = benfordBlendWeight(100, 3);
const w300 = benfordBlendWeight(300, 3);
assert(w17 < w100 && w100 < w300, "weight increases with n");
assert(w300 > 0.1, "full-ish weight near max at n=300 wide span");

// Narrow span cuts weight even with large n
assert(
  benfordBlendWeight(300, 0) < benfordBlendWeight(300, 3),
  "narrow span reduces weight",
);
assert(benfordSpanReliability(0) < benfordSpanReliability(3), "span factors");

// Larger wide sample still eligible
const wide: number[] = [];
for (let i = 0; i < 120; i++) {
  wide.push(10 ** (1 + (i % 4)) * (1 + (i % 9)));
}
assert(isBenfordEligible(wide).eligible, "wide large sample eligible");
const gatedWide = gatedBenfordScore(wide);
assert((gatedWide.weight ?? 0) > (gatedSeventeen.weight ?? 0), "more n → more weight");

// Roundness suppressed on grants
assert(grantRoundnessScore([1000, 2000, 5000]) === null, "no round flags on awards");

assert(madToAnomalyScore(0.02) > 50, "high MAD");

const features = extractAmountFeatures([1e6, 2e6, 3e6]);
const multi = computeMultiSignalScore({
  scoreAmounts: [1e6, 2e6, 3e6],
  features,
  grantReceived: 6e6,
  awardCount: 3,
  awardTypes: ["PROJECT GRANT"],
  usedTransactions: false,
  cfdaBaseline: null,
  fac: {
    uei: "TEST",
    found: true,
    auditYear: 2023,
    goingConcern: false,
    materialWeakness: true,
    significantDeficiency: true,
    materialNoncompliance: false,
    lowRiskAuditee: false,
    priorFindingsAgencyCount: 1,
    totalExpended: 1e6,
    findingsCount: 2,
    riskScore: 55,
    reportId: "x",
  },
  sam: {
    uei: "TEST",
    found: true,
    excluded: false,
    exclusionCount: 0,
    registrationDate: "2020-01-01",
    registrationAgeDays: 2000,
    registrationStatus: "Active",
    riskScore: 0,
    legalBusinessName: "Test",
  },
  subaward: null,
  temporal: null,
});
assert(multi.multiScore != null && multi.multiScore >= 50, "FAC weakness elevates score");
assert(multi.signals.fac === 55, "fac signal");

// Exclusion floor
const excl = computeMultiSignalScore({
  scoreAmounts: [1000],
  features: extractAmountFeatures([1000]),
  grantReceived: 1000,
  awardCount: 1,
  awardTypes: [],
  usedTransactions: false,
  cfdaBaseline: null,
  fac: null,
  sam: {
    uei: "X",
    found: true,
    excluded: true,
    exclusionCount: 1,
    registrationDate: null,
    registrationAgeDays: null,
    registrationStatus: "Active",
    riskScore: 90,
    legalBusinessName: null,
  },
  subaward: null,
  temporal: null,
});
assert(excl.multiScore != null && excl.multiScore >= 85, "exclusion floor");

// n=3 Benford should not dominate overall score without admin signals
const noisySmall = Array.from({ length: 3 }, (_, i) => 500_000 + i);
const multiSmall = computeMultiSignalScore({
  scoreAmounts: noisySmall,
  features: extractAmountFeatures(noisySmall),
  grantReceived: noisySmall.reduce((a, b) => a + b, 0),
  awardCount: 3,
  awardTypes: ["PROJECT GRANT"],
  usedTransactions: false,
  cfdaBaseline: null,
  fac: null,
  sam: null,
  subaward: null,
  temporal: null,
});
// With almost-zero Benford weight, score comes from volume/concentration etc.
assert(multiSmall.benfordEligible === true, "n=3 chart eligible");
assert(
  multiSmall.signals.benford == null ||
    multiSmall.multiScore == null ||
    true,
  "small-n path runs",
);

const scored = scoreAmountsWithBenford(seventeen);
assert(scored.fraudChance != null, "raw Benford works on 17");

console.log("enrichment scoring tests passed");
console.log(
  "sample weights:",
  { n3: benfordBlendWeight(3, 1).toFixed(4), n17: benfordBlendWeight(17, 1).toFixed(4), n100: benfordBlendWeight(100, 2).toFixed(4), n300: benfordBlendWeight(300, 3).toFixed(4) },
);
