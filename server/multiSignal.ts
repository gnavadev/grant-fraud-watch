import {
  concentrationRatio,
  lastDigitBiasScore,
  positiveAmounts,
} from "./amounts.js";
import {
  expectedBenfordProb,
  countLeadingDigits,
  madToAnomalyScore,
  madVsBenford,
  scoreAmountsWithBenford,
  usableBenfordAmounts,
} from "./benford.js";
import type { AmountFeatures, ScoreConfidence, SignalBreakdown } from "./types.js";
import type { CfdaBaseline } from "./usaspending.js";
import type { FacAuditSummary } from "./fac.js";
import type { SamEntitySummary } from "./sam.js";
import type { SubawardConcentration } from "./subawards.js";
import type { TemporalRisk } from "./temporal.js";

export interface MultiSignalResult {
  multiScore: number | null;
  confidence: ScoreConfidence;
  signals: SignalBreakdown;
  avgAward: number | null;
  benfordEligible: boolean;
}

/**
 * Minimum amounts to compute Benford (any positive amount).
 * Charts always show when counts exist; blend weight stays near zero until
 * n is large (see benfordSizeReliability).
 */
export const MIN_BENFORD_ELIGIBLE = 1;

/**
 * Max relative weight of Benford in the multi-signal blend when fully reliable
 * (n ≳ 300 and multi-order magnitude span). Kept modest: grants violate Benford
 * assumptions (caps, formula awards) even with large n.
 */
export const BENFORD_MAX_WEIGHT = 0.12;

/**
 * Sample-size reliability ∈ [0, 1] for Benford MAD claims.
 *
 * Logistic curve aligned with Nigrini guidance:
 *   · below ~100 records → mostly noise (r ≲ 0.25)
 *   · ~150 → midpoint (r ≈ 0.5)
 *   · ~300+ → MAD bands more reliable (r ≳ 0.96)
 *
 *   r(n) = 1 / (1 + exp(-(n − 150) / 45))
 *
 * Approx: n=3→0.04, n=17→0.05, n=40→0.08, n=100→0.25, n=300→0.96
 */
export function benfordSizeReliability(n: number): number {
  if (n < 1) return 0;
  return 1 / (1 + Math.exp(-(n - 150) / 45));
}

/**
 * Magnitude-span reliability ∈ [0, 1].
 * Benford expects data across several orders of magnitude; capped/formula
 * grant awards often live in one band and look “non-Benford” while clean.
 */
export function benfordSpanReliability(spanOrders: number): number {
  if (spanOrders <= 0) return 0.15;
  if (spanOrders === 1) return 0.35;
  if (spanOrders === 2) return 0.65;
  return 1; // 3+
}

/**
 * Effective blend weight for Benford given sample size and magnitude span.
 *   w(n, span) = BENFORD_MAX_WEIGHT · r_size(n) · r_span(span)
 */
export function benfordBlendWeight(n: number, spanOrders: number): number {
  return (
    BENFORD_MAX_WEIGHT *
    benfordSizeReliability(n) *
    benfordSpanReliability(spanOrders)
  );
}

export function isBenfordEligible(amounts: number[]): {
  eligible: boolean;
  reason: string;
  spanOrders: number;
  n: number;
} {
  const usable = usableBenfordAmounts(amounts);
  const n = usable.length;
  if (n < MIN_BENFORD_ELIGIBLE) {
    return {
      eligible: false,
      reason: `n=${n}<${MIN_BENFORD_ELIGIBLE}`,
      spanOrders: 0,
      n,
    };
  }
  const logs = usable.map((a) => Math.floor(Math.log10(Math.max(a, 1e-12))));
  const span = Math.max(...logs) - Math.min(...logs);
  return {
    eligible: true,
    reason: span < 2 ? "ok_narrow_span" : "ok",
    spanOrders: span,
    n,
  };
}

/**
 * Benford anomaly score (0–100) plus sample-dependent blend weight.
 * Chart/score available from n≥3; weight scales with n so small samples
 * barely move the overall fraud chance.
 */
export function gatedBenfordScore(amounts: number[]): {
  score: number | null;
  eligible: boolean;
  confidence: ScoreConfidence;
  spanOrders?: number;
  n?: number;
  /** Relative weight for multi-signal blend (already size×span scaled). */
  weight?: number;
  sizeReliability?: number;
  spanReliability?: number;
} {
  const gate = isBenfordEligible(amounts);
  if (!gate.eligible) {
    return {
      score: null,
      eligible: false,
      confidence: "none",
      n: gate.n,
      weight: 0,
    };
  }
  const full = scoreAmountsWithBenford(amounts);
  const sizeRel = benfordSizeReliability(gate.n);
  const spanRel = benfordSpanReliability(gate.spanOrders);
  const weight = benfordBlendWeight(gate.n, gate.spanOrders);

  if (full.fraudChance == null) {
    return {
      score: null,
      eligible: true,
      confidence: "none",
      spanOrders: gate.spanOrders,
      n: gate.n,
      weight: 0,
      sizeReliability: sizeRel,
      spanReliability: spanRel,
    };
  }

  // Confidence follows Nigrini sample bands, not just eligibility
  const confidence: ScoreConfidence =
    gate.n >= 300 && gate.spanOrders >= 2
      ? "high"
      : gate.n >= 100
        ? "low"
        : "low";

  return {
    score: full.fraudChance,
    eligible: true,
    confidence,
    spanOrders: gate.spanOrders,
    n: gate.n,
    weight,
    sizeReliability: sizeRel,
    spanReliability: spanRel,
  };
}

/**
 * Last-digit bias only on transaction-like series with enough n and variance.
 * Suppressed for typical award-only sets (use usedTransactions flag).
 */
export function gatedLastDigitScore(
  amounts: number[],
  fromTransactions: boolean,
): number | null {
  if (!fromTransactions) return null;
  const usable = usableBenfordAmounts(amounts);
  if (usable.length < 50) return null;
  return lastDigitBiasScore(usable);
}

/** Round-number flags suppressed for grant awards (budgets are supposed to be round). */
export function grantRoundnessScore(_amounts: number[]): number | null {
  return null;
}

export function concentrationToScore(ratio: number): number {
  const adjusted = Math.max(0, (ratio - 0.35) / 0.65);
  return Math.round(Math.min(100, adjusted * 100));
}

export function giniConcentrationScore(amounts: number[]): number {
  const pos = positiveAmounts(amounts).sort((a, b) => a - b);
  const n = pos.length;
  if (n < 2) return 0;
  const sum = pos.reduce((a, b) => a + b, 0);
  if (sum <= 0) return 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) {
    weighted += (2 * (i + 1) - n - 1) * pos[i];
  }
  const gini = weighted / (n * sum);
  const adjusted = Math.max(0, (gini - 0.35) / 0.55);
  return Math.round(Math.min(100, adjusted * 100));
}

export function awardVolumeScore(
  awardCount: number,
  grantReceived: number,
  awardTypeFactor = 1,
): number {
  if (awardCount <= 0 || grantReceived <= 0) return 0;
  const avg = grantReceived / awardCount;
  let best = 0;
  if (avg >= 250_000) {
    const logAvg = Math.log10(avg);
    best = Math.max(best, 100 * (1 - Math.exp(-(logAvg - 5.4) / 1.15)));
  }
  if (awardCount === 1 && grantReceived >= 2_000_000) best = Math.max(best, 42);
  if (awardCount === 1 && grantReceived >= 20_000_000) best = Math.max(best, 62);
  if (awardCount <= 2 && grantReceived >= 10_000_000) best = Math.max(best, 50);
  if (awardCount <= 3 && grantReceived >= 50_000_000) best = Math.max(best, 65);
  if (awardCount >= 12 && avg < 75_000 && grantReceived >= 500_000)
    best = Math.max(best, 38);
  if (awardCount >= 25 && avg < 40_000 && grantReceived >= 1_000_000)
    best = Math.max(best, 52);
  best *= awardTypeFactor;
  return Math.round(Math.min(100, best));
}

export function programNormScore(
  avgAward: number,
  awardCount: number,
  baseline: CfdaBaseline | null,
  awardTypeFactor = 1,
): number | null {
  if (!baseline || baseline.medianAward <= 0 || avgAward <= 0) return null;
  const ratio = avgAward / baseline.medianAward;
  let score = 0;
  if (ratio >= 1) {
    const logR = Math.log10(Math.max(ratio, 1));
    score = 100 * (1 - Math.exp(-logR / 0.85));
  } else if (awardCount >= 5) {
    const inv = 1 / Math.max(ratio, 0.01);
    score = 55 * (1 - Math.exp(-Math.log10(inv) / 1.1));
  }
  score *= awardTypeFactor;
  return Math.round(Math.min(100, Math.max(0, score)));
}

export function awardTypeScaleFactor(awardTypes: string[]): number {
  if (awardTypes.length === 0) return 1;
  const joined = awardTypes.join(" ").toUpperCase();
  if (joined.includes("BLOCK") || joined.includes("FORMULA")) return 0.45;
  if (joined.includes("COOPERATIVE")) return 0.75;
  if (joined.includes("PROJECT")) return 1;
  return 0.85;
}

export function dispersionScore(features: AmountFeatures): number {
  if (features.n < 2) return 0;
  let best = 0;
  if (features.maxToMean >= 2.5) {
    best = Math.max(
      best,
      100 * (1 - Math.exp(-(features.maxToMean - 2.5) / 3.5)),
    );
  }
  if (features.cv >= 0.75) {
    best = Math.max(
      best,
      100 * (1 - Math.exp(-(features.cv - 0.75) / 0.7)) * 0.95,
    );
  }
  return Math.round(Math.min(100, best));
}

export function modNoiseScore(pctNegative: number): number {
  if (pctNegative < 0.08) return 0;
  return Math.round(Math.min(100, ((pctNegative - 0.08) / 0.45) * 100));
}

/**
 * Primary risk blend: FAC + SAM first, then pass-through / temporal / structure.
 * Digit tests only when gated eligible.
 */
export function computeMultiSignalScore(input: {
  scoreAmounts: number[];
  features: AmountFeatures;
  grantReceived: number;
  awardCount: number;
  awardTypes: string[];
  usedTransactions: boolean;
  cfdaBaseline: CfdaBaseline | null;
  fac: FacAuditSummary | null;
  sam: SamEntitySummary | null;
  subaward: SubawardConcentration | null;
  temporal: TemporalRisk | null;
}): MultiSignalResult {
  const {
    scoreAmounts,
    features,
    grantReceived,
    awardCount,
    awardTypes,
    usedTransactions,
    cfdaBaseline,
    fac,
    sam,
    subaward,
    temporal,
  } = input;

  const typeFactor = awardTypeScaleFactor(awardTypes);
  const avgAward =
    awardCount > 0 && grantReceived > 0 ? grantReceived / awardCount : 0;

  const benfordGate = gatedBenfordScore(scoreAmounts);
  const lastDigit = gatedLastDigitScore(scoreAmounts, usedTransactions);

  const volume =
    awardCount > 0 && grantReceived > 0
      ? awardVolumeScore(awardCount, grantReceived, typeFactor)
      : null;
  const program = programNormScore(
    avgAward,
    awardCount,
    cfdaBaseline,
    typeFactor,
  );

  const maxShare =
    scoreAmounts.length >= 2
      ? concentrationToScore(concentrationRatio(scoreAmounts))
      : null;
  const gini =
    scoreAmounts.length >= 3 ? giniConcentrationScore(scoreAmounts) : null;
  const concentration =
    maxShare != null || gini != null
      ? Math.round(Math.max(maxShare ?? 0, gini ?? 0))
      : null;

  const dispersion =
    scoreAmounts.length >= 2 ? dispersionScore(features) : null;
  const modNoise =
    usedTransactions && features.n >= 3
      ? modNoiseScore(features.pctNegative)
      : null;

  const facScore = fac?.found ? fac.riskScore : fac ? 0 : null;
  const samScore = sam?.found ? sam.riskScore : sam ? 0 : null;
  const subScore = subaward && subaward.subCount > 0 ? subaward.riskScore : null;
  const tempScore =
    temporal && temporal.txnCount >= 5 ? temporal.riskScore : null;

  // Roundness intentionally null for grant awards
  const roundness = grantRoundnessScore(scoreAmounts);

  const signals: SignalBreakdown = {
    benford: benfordGate.score,
    volume,
    program,
    roundness,
    concentration,
    lastDigit,
    dispersion,
    modNoise,
    fac: facScore,
    sam: samScore,
    subaward: subScore,
    temporal: tempScore,
  };

  // Weight: administrative risk first when available (Benford mixed in after,
  // with absolute α so tiny samples cannot renormalize to 100% influence).
  type Part = { w: number; v: number };
  const parts: Part[] = [];

  if (facScore != null && facScore > 0) parts.push({ w: 0.32, v: facScore });
  if (samScore != null && samScore > 0) parts.push({ w: 0.28, v: samScore });
  if (subScore != null && subScore > 0) parts.push({ w: 0.14, v: subScore });
  if (tempScore != null && tempScore > 0) parts.push({ w: 0.12, v: tempScore });

  if (volume != null && volume > 0) parts.push({ w: 0.08, v: volume });
  if (program != null && program > 0) parts.push({ w: 0.08, v: program });
  if (concentration != null && concentration > 0)
    parts.push({ w: 0.05, v: concentration });
  if (dispersion != null && dispersion > 0)
    parts.push({ w: 0.04, v: dispersion });
  if (modNoise != null && modNoise > 0) parts.push({ w: 0.04, v: modNoise });
  if (lastDigit != null && lastDigit > 0) parts.push({ w: 0.03, v: lastDigit });

  // If no admin sources, redistribute to math-only absolute signals
  if (parts.length === 0) {
    if (volume != null) parts.push({ w: 0.35, v: volume });
    if (program != null) parts.push({ w: 0.25, v: program });
    if (concentration != null) parts.push({ w: 0.2, v: concentration });
    if (dispersion != null) parts.push({ w: 0.12, v: dispersion });
    if (modNoise != null) parts.push({ w: 0.08, v: modNoise });
  }

  /**
   * Benford mix-in coefficient α ∈ [0, BENFORD_MAX_WEIGHT]:
   *   α(n, span) = BENFORD_MAX_WEIGHT · r_size(n) · r_span(span)
   * final = (1 − α) · base + α · benford
   * Small n → α ≈ 0 so Benford barely moves the score (no renorm trick).
   */
  const alpha =
    benfordGate.score != null ? (benfordGate.weight ?? 0) : 0;

  if (parts.length === 0 && alpha < 1e-6) {
    return {
      multiScore: null,
      confidence: "none",
      signals,
      avgAward: avgAward || null,
      benfordEligible: benfordGate.eligible,
    };
  }

  let baseScore = 0;
  if (parts.length > 0) {
    const wSum = parts.reduce((a, p) => a + p.w, 0);
    baseScore = parts.reduce((a, p) => a + (p.w / wSum) * p.v, 0);
  }

  let multiScore =
    parts.length === 0
      ? // Benford alone: only the reliability-scaled portion counts
        alpha * (benfordGate.score ?? 0)
      : (1 - alpha) * baseScore + alpha * (benfordGate.score ?? baseScore);

  // Hard floors: exclusion / material weakness should never look "low"
  if (sam?.excluded) multiScore = Math.max(multiScore, 85);
  if (fac?.materialWeakness || fac?.goingConcern)
    multiScore = Math.max(multiScore, 70);

  let confidence: ScoreConfidence = "model";
  if (fac?.found || sam?.found) confidence = "high";
  else if (benfordGate.eligible && benfordGate.confidence === "high")
    confidence = "high";
  else if (parts.length >= 2) confidence = "low";

  return {
    multiScore: Math.round(Math.min(100, Math.max(0, multiScore))),
    confidence,
    signals,
    avgAward: avgAward || null,
    benfordEligible: benfordGate.eligible,
  };
}

/** Exported for tests */
export function madScoreFromAmounts(amounts: number[]): number {
  const counts = countLeadingDigits(usableBenfordAmounts(amounts));
  const { mad } = madVsBenford(counts);
  return madToAnomalyScore(mad);
}

export function expectedDigit(d: number): number {
  return expectedBenfordProb(d);
}
