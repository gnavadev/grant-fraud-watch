export type FacilityTypeKey =
  | "all"
  | "daycare"
  | "healthcare"
  | "education"
  | "housing"
  | "food"
  | "other";

export type FraudLabel = "low" | "medium" | "high" | "insufficient";
export type ScoreConfidence = "high" | "low" | "model" | "none";
export type ScoreMethod = "statistical" | "none";

export interface FacilityFilters {
  state: string;
  city: string;
  county: string;
  type: FacilityTypeKey;
  q: string;
}

export interface BenfordDetail {
  sampleSize: number;
  chiSquare: number | null;
  mad?: number | null;
  digitCounts: Record<string, number>;
  minFullSample: number;
  minLowSample: number;
}

export interface AmountFeatures {
  n: number;
  sum: number;
  mean: number;
  std: number;
  median: number;
  min: number;
  max: number;
  cv: number;
  maxToMean: number;
  pctRound: number;
  pctNegative: number;
  logSum: number;
  logMean: number;
  digitEntropy: number;
  benfordMad: number;
  benfordChi: number;
}

export interface SignalBreakdown {
  benford: number | null;
  volume: number | null;
  program: number | null;
  roundness: number | null;
  concentration: number | null;
  lastDigit: number | null;
  dispersion: number | null;
  modNoise: number | null;
  fac: number | null;
  sam: number | null;
  subaward: number | null;
  temporal: number | null;
}

export interface Facility {
  id: string;
  name: string;
  city: string | null;
  county: string | null;
  state: string | null;
  grantReceived: number;
  awardCount: number;
  /** True when grant count is the full recipient list (not search sample only). */
  grantsHydrated?: boolean;
  sampleCount: number;
  fraudChance: number | null;
  fraudLabel: FraudLabel;
  confidence: ScoreConfidence;
  scoreMethod: ScoreMethod;
  scoreStatus?: "ok" | "failed" | "retrying";
  failReasons?: string[];
  benfordScore: number | null;
  multiScore: number | null;
  signals?: SignalBreakdown;
  avgAward?: number | null;
  primaryCfda?: string | null;
  awardTypes?: string[];
  uei?: string | null;
  recipientId?: string | null;
  benfordEligible?: boolean;
  rescore?: {
    scoreAmounts: number[];
    awardTypes: string[];
    usedTransactions: boolean;
    primaryCfda: string | null;
    grantReceived: number;
    awardCount: number;
  };
  enrichment?: {
    fac?: {
      found: boolean;
      riskScore: number;
      findingsCount: number;
      materialWeakness: boolean;
      goingConcern: boolean;
      lowRiskAuditee: boolean;
      /** FAC report_id → https://app.fac.gov/dissemination/summary/{reportId} */
      reportId?: string | null;
      auditYear?: number | null;
    } | null;
    sam?: {
      found: boolean;
      riskScore: number;
      excluded: boolean;
      registrationAgeDays: number | null;
      legalBusinessName?: string | null;
    } | null;
    subaward?: {
      riskScore: number;
      topSubShare: number;
      uniqueSubs: number;
    } | null;
    temporal?: {
      riskScore: number;
      fyq4Share: number;
      deobligationShare: number;
    } | null;
  };
  benford: BenfordDetail;
  features: AmountFeatures;
  deepScored?: boolean;
}

export interface FacilitiesResponse {
  facilities: Facility[];
  meta: {
    awardCount: number;
    facilityCount: number;
    scoredCount: number;
    insufficientCount: number;
    filters: Partial<FacilityFilters>;
    disclaimer: string;
    transactionCount?: number;
    page: number;
    pageSize: number;
    totalPages: number;
    hasMore: boolean;
    cache?: {
      awards: boolean;
      transactions: boolean;
      response?: boolean;
    };
  };
}

export type SortKey =
  | "name"
  | "city"
  | "county"
  | "state"
  | "grantReceived"
  | "fraudChance";

export type SortDir = "asc" | "desc";

export interface SortSpec {
  key: SortKey;
  dir: SortDir;
}
