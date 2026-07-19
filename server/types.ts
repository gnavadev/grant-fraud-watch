export type FacilityTypeKey =
  | "all"
  | "daycare"
  | "healthcare"
  | "education"
  | "housing"
  | "food"
  | "other";

export type FraudLabel = "low" | "medium" | "high" | "insufficient";

/** How trustworthy the fraud chance is for lay users. */
export type ScoreConfidence = "high" | "low" | "model" | "none";

/** Absolute multi-signal statistical score (no peer ranking, no XGBoost). */
export type ScoreMethod = "statistical" | "none";

export interface SignalBreakdown {
  benford: number | null;
  volume: number | null;
  program: number | null;
  roundness: number | null;
  concentration: number | null;
  lastDigit: number | null;
  dispersion: number | null;
  modNoise: number | null;
  /** FAC Single Audit risk (findings / weaknesses). */
  fac: number | null;
  /** SAM exclusion + registration-age risk. */
  sam: number | null;
  /** Subaward pass-through concentration. */
  subaward: number | null;
  /** End-of-FY / mod / de-obligation temporal risk. */
  temporal: number | null;
}

export interface FacilityFilters {
  state?: string;
  city?: string;
  county?: string;
  type?: FacilityTypeKey;
  q?: string;
}

/** Location may be a structured object or (rarely) a string. */
export type AwardLocation =
  | string
  | {
      location_country_code?: string | null;
      country_name?: string | null;
      state_code?: string | null;
      state_name?: string | null;
      city_name?: string | null;
      county_code?: string | null;
      county_name?: string | null;
    }
  | null;

export interface AwardRow {
  internal_id?: number;
  "Award ID"?: string;
  "Recipient Name"?: string | null;
  recipient_id?: string | null;
  "Award Amount"?: number | null;
  "Recipient Location"?: AwardLocation;
  "Primary Place of Performance"?: AwardLocation;
  "Award Type"?: string | null;
  Description?: string | null;
  "CFDA Number"?: string | null;
  "Recipient UEI"?: string | null;
  "Assistance Listings"?: { cfda_number?: string; cfda_program_title?: string }[];
  primary_assistance_listing?: {
    cfda_number?: string | null;
    cfda_program_title?: string | null;
  } | null;
  "Place of Performance State Code"?: string | number | null;
  "Place of Performance City Code"?: string | number | null;
}

export interface TransactionRow {
  "Award ID"?: string;
  "Recipient Name"?: string | null;
  recipient_id?: string | null;
  "Transaction Amount"?: number | null;
  "Action Date"?: string | null;
  Mod?: string | null;
}

export interface ParsedLocation {
  city: string | null;
  county: string | null;
  state: string | null;
}

export interface BenfordDetail {
  sampleSize: number;
  chiSquare: number | null;
  mad?: number | null;
  digitCounts: Record<string, number>;
  minFullSample: number;
  minLowSample: number;
}

/** Numeric features used by XGBoost (and shown for debugging). */
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

export interface Facility {
  id: string;
  name: string;
  city: string | null;
  county: string | null;
  state: string | null;
  grantReceived: number;
  awardCount: number;
  /**
   * True when awardCount comes from a full recipient grant pull.
   * False = search-sample only (may undercount).
   */
  grantsHydrated?: boolean;
  /** Number of amount observations used for scoring (awards or transactions). */
  sampleCount: number;
  fraudChance: number | null;
  fraudLabel: FraudLabel;
  confidence: ScoreConfidence;
  scoreMethod: ScoreMethod;
  /** ok = enrichment done; failed = FAC/SAM error (client will retry); retrying = in progress */
  scoreStatus?: "ok" | "failed" | "retrying";
  failReasons?: string[];
  benfordScore: number | null;
  multiScore: number | null;
  signals?: SignalBreakdown;
  avgAward?: number | null;
  primaryCfda?: string | null;
  awardTypes?: string[];
  uei?: string | null;
  /** USAspending recipient_id (hash-level), for direct profile links. */
  recipientId?: string | null;
  benfordEligible?: boolean;
  /** Payload so the client can retry enrichment without re-searching. */
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
      /** FAC report_id for deep links to app.fac.gov summary pages. */
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
    filters: FacilityFilters;
    disclaimer: string;
    transactionCount?: number;
    cache?: { awards: boolean; transactions: boolean };
  };
}
