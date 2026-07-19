import type { BenfordDetail, FraudLabel, ScoreConfidence } from "./types.js";

/** Soft “full” confidence sample size for digit estimates (still weak vs Nigrini). */
export const MIN_BENFORD_FULL = 50;

/** Minimum sample for a numeric Benford score (charts work with n ≥ 1). */
export const MIN_BENFORD_LOW = 1;

/** Benford expected probability: log10(1 + 1/d). */
export function expectedBenfordProb(digit: number): number {
  if (digit < 1 || digit > 9) return 0;
  return Math.log10(1 + 1 / digit);
}

export function leadingDigit(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const abs = Math.abs(value);
  const exp = Math.floor(Math.log10(abs));
  const mantissa = abs / 10 ** exp;
  const digit = Math.floor(mantissa);
  if (digit < 1 || digit > 9) return null;
  return digit;
}

export function usableBenfordAmounts(amounts: number[]): number[] {
  return amounts
    .filter((a) => Number.isFinite(a) && a !== 0)
    .map((a) => Math.abs(a));
}

export function countLeadingDigits(amounts: number[]): Record<number, number> {
  const counts: Record<number, number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
    6: 0,
    7: 0,
    8: 0,
    9: 0,
  };
  for (const amount of amounts) {
    const d = leadingDigit(amount);
    if (d !== null) counts[d] += 1;
  }
  return counts;
}

export function chiSquareVsBenford(counts: Record<number, number>): {
  chiSquare: number;
  sampleSize: number;
} {
  let sampleSize = 0;
  for (let d = 1; d <= 9; d++) sampleSize += counts[d] ?? 0;
  if (sampleSize === 0) return { chiSquare: 0, sampleSize: 0 };

  let chiSquare = 0;
  for (let d = 1; d <= 9; d++) {
    const observed = counts[d] ?? 0;
    const expected = sampleSize * expectedBenfordProb(d);
    if (expected > 0) chiSquare += (observed - expected) ** 2 / expected;
  }
  return { chiSquare, sampleSize };
}

/**
 * Mean Absolute Deviation of leading-digit frequencies vs Benford (Nigrini).
 * MAD = mean_d |O_d/n - E_d|
 */
export function madVsBenford(counts: Record<number, number>): {
  mad: number;
  sampleSize: number;
} {
  let sampleSize = 0;
  for (let d = 1; d <= 9; d++) sampleSize += counts[d] ?? 0;
  if (sampleSize === 0) return { mad: 0, sampleSize: 0 };

  let sum = 0;
  for (let d = 1; d <= 9; d++) {
    const obs = (counts[d] ?? 0) / sampleSize;
    const exp = expectedBenfordProb(d);
    sum += Math.abs(obs - exp);
  }
  return { mad: sum / 9, sampleSize };
}

/**
 * Map Nigrini MAD bands to 0–100 anomaly score.
 * Close ≤0.006, Acceptable ≤0.012, Marginal ≤0.015, Nonconformity >0.015
 */
export function madToAnomalyScore(mad: number): number {
  if (mad <= 0.006) {
    return Math.round((mad / 0.006) * 18);
  }
  if (mad <= 0.012) {
    return Math.round(18 + ((mad - 0.006) / 0.006) * 22);
  }
  if (mad <= 0.015) {
    return Math.round(40 + ((mad - 0.012) / 0.003) * 20);
  }
  // Nonconformity: ramp toward 100
  const extra = (mad - 0.015) / 0.04;
  return Math.round(Math.min(100, 60 + extra * 40));
}

export function chiSquareToFraudChance(chiSquare: number): number {
  const score = 100 * (1 - Math.exp(-chiSquare / 20));
  return Math.round(Math.min(100, Math.max(0, score)));
}

export function fraudLabelFromChance(chance: number | null): FraudLabel {
  if (chance === null) return "insufficient";
  if (chance <= 33) return "low";
  if (chance <= 66) return "medium";
  return "high";
}

export interface BenfordScoreResult {
  fraudChance: number | null;
  fraudLabel: FraudLabel;
  confidence: ScoreConfidence;
  benford: BenfordDetail;
  mad: number | null;
}

/**
 * Benford score using MAD (primary) blended with chi-square (secondary).
 * MAD is the standard conformity metric in forensic accounting literature.
 */
export function scoreAmountsWithBenford(amounts: number[]): BenfordScoreResult {
  const usable = usableBenfordAmounts(amounts);
  const counts = countLeadingDigits(usable);
  const { chiSquare, sampleSize } = chiSquareVsBenford(counts);
  const { mad } = madVsBenford(counts);

  const digitCounts: Record<string, number> = {};
  for (let d = 1; d <= 9; d++) digitCounts[String(d)] = counts[d] ?? 0;

  const baseDetail: BenfordDetail = {
    sampleSize,
    chiSquare: sampleSize === 0 ? null : chiSquare,
    digitCounts,
    minFullSample: MIN_BENFORD_FULL,
    minLowSample: MIN_BENFORD_LOW,
    mad: sampleSize === 0 ? null : mad,
  };

  if (sampleSize < MIN_BENFORD_LOW) {
    return {
      fraudChance: null,
      fraudLabel: "insufficient",
      confidence: "none",
      benford: baseDetail,
      mad: null,
    };
  }

  const madScore = madToAnomalyScore(mad);
  const chiScore = chiSquareToFraudChance(chiSquare);
  // Prefer MAD (forensic standard); chi-square as mild corroboration
  const fraudChance = Math.round(0.7 * madScore + 0.3 * chiScore);
  const confidence: ScoreConfidence =
    sampleSize >= MIN_BENFORD_FULL ? "high" : "low";

  return {
    fraudChance: Math.min(100, Math.max(0, fraudChance)),
    fraudLabel: fraudLabelFromChance(fraudChance),
    confidence,
    benford: baseDetail,
    mad,
  };
}
