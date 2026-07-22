/**
 * Offline batch scoring from DuckDB (no USAspending/FAC HTTP).
 */
import { cleanAmountsForScoring, positiveAmounts } from "./amounts.js";
import { fraudLabelFromChance, scoreAmountsWithBenford } from "./benford.js";
import { classifyFacilityTypes } from "./bulkClassify.js";
import { openBulkDuck, type DuckConn } from "./bulkDuck.js";
import { extractAmountFeatures } from "./features.js";
import type { FacAuditSummary } from "./fac.js";
import { computeMultiSignalScore } from "./multiSignal.js";
import { getEntityFromExtract } from "./samEntityExtract.js";
import { isUeiExcluded } from "./samExtract.js";
import { usaspendingRecipientIdFromUei } from "./usaspendingRecipientId.js";
import type {
  Facility,
  FacilityTypeKey,
  FraudLabel,
  ScoreConfidence,
  ScoreMethod,
  SignalBreakdown,
} from "./types.js";

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

/** YYYY-MM-DD today (UTC) for comparing extract expiration_date. */
function todayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Public SAM "currently active registration" from local extract.
 * Status A alone is not enough: monthly extract can still list rows whose
 * registrationExpirationDate has already passed (API then says Inactive).
 * Those must not get clickable Active entity links.
 */
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

/**
 * Public SAM summary from local extracts.
 * `found` drives clickable SAM links — only when we expect a public sam.gov hit:
 *   - currently active registration (status A/Active AND expiration not past), or
 *   - UEI on public exclusions list
 * Status E, expired-by-date, and missing rows stay found=false (grey link).
 */
function samFromExtracts(uei: string): {
  found: boolean;
  excluded: boolean;
  riskScore: number;
  registrationAgeDays: number | null;
  legalBusinessName: string | null;
} {
  const excluded = isUeiExcluded(uei) === true;
  const entity = getEntityFromExtract(uei);
  const isActive = isCurrentlyActiveRegistration(entity);
  const age = daysSince(entity?.registrationDate ?? null);
  // Age risk only for active regs (expired are not "new shell" signal the same way)
  let riskScore = isActive ? ageRisk(age) : 0;
  if (excluded) riskScore = Math.min(100, riskScore + 85);
  return {
    found: isActive || excluded,
    excluded,
    riskScore: Math.min(100, riskScore),
    registrationAgeDays: isActive ? age : null,
    legalBusinessName: entity?.legalBusinessName ?? null,
  };
}

export interface BulkScoreConfig {
  minEvidenceN: number;
  /** Optional filter to one state for faster publish */
  onlyState?: string;
  onlyType?: FacilityTypeKey;
}

export interface BulkScoredFacility {
  id: string;
  uei: string | null;
  /** Deterministic USAspending profile id (md5 UUID + -C); no API. */
  recipientId?: string | null;
  name: string;
  city: string | null;
  county: string | null;
  state: string;
  types: FacilityTypeKey[];
  grantReceived: number;
  awardCount: number;
  sampleCount: number;
  amounts: number[];
  primaryCfda: string | null;
  fraudChance: number | null;
  fraudLabel: FraudLabel;
  confidence: ScoreConfidence;
  scoreMethod: ScoreMethod;
  multiScore: number | null;
  benfordScore: number | null;
  signals: SignalBreakdown;
  avgAward: number | null;
  benfordEligible: boolean;
  enrichment: Facility["enrichment"];
  features: Facility["features"];
  benford: Facility["benford"];
  insufficient: boolean;
}

function yes(v: unknown): boolean {
  if (v === true) return true;
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return s === "yes" || s === "y" || s === "true" || s === "1";
}

function facFromRow(
  uei: string,
  row: Record<string, unknown> | null,
): FacAuditSummary | null {
  if (!row) return null;
  const findingsCount = Number(row.findings_count ?? 0) || 0;
  let riskScore = 0;
  if (yes(row.is_going_concern_included)) riskScore += 35;
  if (yes(row.is_internal_control_material_weakness_disclosed)) riskScore += 30;
  if (yes(row.is_material_noncompliance_disclosed)) riskScore += 25;
  if (yes(row.is_internal_control_deficiency_disclosed)) riskScore += 15;
  if (
    !yes(row.is_low_risk_auditee) &&
    row.is_low_risk_auditee != null &&
    String(row.is_low_risk_auditee).trim() !== ""
  ) {
    riskScore += 10;
  }
  const prior = String(row.agencies_with_prior_findings ?? "00");
  if (prior && prior !== "00" && prior !== "0") riskScore += 20;
  riskScore = Math.min(100, riskScore + Math.min(30, findingsCount * 10));

  return {
    uei,
    found: true,
    auditYear:
      row.audit_year != null ? Number(row.audit_year) : null,
    goingConcern: yes(row.is_going_concern_included),
    materialWeakness: yes(row.is_internal_control_material_weakness_disclosed),
    significantDeficiency: yes(row.is_internal_control_deficiency_disclosed),
    materialNoncompliance: yes(row.is_material_noncompliance_disclosed),
    lowRiskAuditee: yes(row.is_low_risk_auditee),
    priorFindingsAgencyCount:
      prior && prior !== "00" ? Math.max(1, prior.replace(/0/g, "").length) : 0,
    totalExpended:
      row.total_amount_expended != null
        ? Number(row.total_amount_expended)
        : null,
    findingsCount,
    riskScore,
    reportId: row.report_id != null ? String(row.report_id) : null,
  };
}

function parseAmounts(raw: unknown): number[] {
  if (raw == null) return [];
  if (typeof raw === "number" && Number.isFinite(raw)) return [raw];
  if (Array.isArray(raw)) {
    return raw.map(Number).filter((n) => Number.isFinite(n));
  }
  if (typeof raw === "object") {
    // DuckDB list / typed array / {0: x, 1: y}
    const o = raw as Record<string, unknown>;
    if (typeof (o as { length?: number }).length === "number") {
      try {
        return Array.from(raw as ArrayLike<unknown>)
          .map(Number)
          .filter((n) => Number.isFinite(n));
      } catch {
        /* fall through */
      }
    }
    const vals = Object.values(o)
      .map(Number)
      .filter((n) => Number.isFinite(n));
    if (vals.length) return vals;
  }
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) {
        return p.map(Number).filter((n) => Number.isFinite(n));
      }
    } catch {
      /* fall through */
    }
  }
  return [];
}

function parseStringList(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === "object") {
    try {
      return Array.from(raw as ArrayLike<unknown>)
        .map(String)
        .filter((s) => s && s !== "null");
    } catch {
      return Object.values(raw as object).map(String).filter(Boolean);
    }
  }
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) return p.map(String);
    } catch {
      return raw ? [raw] : [];
    }
  }
  return [];
}

/**
 * Pure-ish score from amounts + optional FAC/SAM (no network).
 */
export function scoreRecipient(input: {
  amounts: number[];
  fac: FacAuditSummary | null;
  excluded: boolean;
}): {
  fraudChance: number | null;
  fraudLabel: FraudLabel;
  confidence: ScoreConfidence;
  scoreMethod: ScoreMethod;
  multiScore: number | null;
  benfordScore: number | null;
  signals: SignalBreakdown;
  avgAward: number | null;
  benfordEligible: boolean;
  features: Facility["features"];
  benford: Facility["benford"];
} {
  const scoreAmounts = cleanAmountsForScoring(input.amounts);
  const grantReceived = positiveAmounts(input.amounts).reduce((a, b) => a + b, 0);
  const awardCount = positiveAmounts(input.amounts).length;
  const features = extractAmountFeatures(scoreAmounts);
  const benfordDetail = scoreAmountsWithBenford(scoreAmounts);

  // Statistical score: FAC + amount structure only.
  // SAM exclusion is ground-truth admin status — applied as an explicit floor
  // after the blend so (1) auditors still see excluded orgs as high priority and
  // (2) we can validate the statistical score against exclusions separately.
  const multi = computeMultiSignalScore({
    scoreAmounts,
    features,
    grantReceived,
    awardCount,
    awardTypes: [],
    usedTransactions: false,
    cfdaBaseline: null,
    fac: input.fac,
    sam: null,
    subaward: null,
    temporal: null,
  });

  let fraudChance = multi.multiScore;
  let fraudLabel = fraudLabelFromChance(multi.multiScore);
  let scoreMethod: ScoreMethod =
    multi.multiScore != null ? "statistical" : "none";

  // Documented admin override (not a latent feature weight):
  // excluded UEI → floor at 90 so triage never buries debarred entities.
  if (input.excluded) {
    const floor = 90;
    if (fraudChance == null || fraudChance < floor) {
      fraudChance = floor;
      fraudLabel = fraudLabelFromChance(fraudChance);
      scoreMethod = "statistical";
    }
  }

  return {
    fraudChance,
    fraudLabel,
    confidence: multi.confidence,
    scoreMethod,
    multiScore: fraudChance,
    benfordScore: multi.signals.benford,
    signals: {
      ...multi.signals,
      // Surface exclusion as SAM signal for UI transparency
      sam: input.excluded ? 85 : multi.signals.sam,
    } as SignalBreakdown,
    avgAward: multi.avgAward,
    benfordEligible: multi.benfordEligible,
    features,
    benford: benfordDetail.benford,
  };
}

/**
 * Load all recipients from DuckDB, score, assign types.
 */
export async function scoreAllFromDuck(
  cfg: BulkScoreConfig,
  conn?: DuckConn,
): Promise<{
  facilities: BulkScoredFacility[];
  stats: {
    recipients: number;
    scored: number;
    insufficient: number;
    withFac: number;
    withSam: number;
  };
}> {
  const own = !conn;
  const db = conn ?? (await openBulkDuck());

  try {
    const stateFilter = cfg.onlyState
      ? `AND UPPER(TRIM(state_code)) = '${cfg.onlyState.replace(/'/g, "''")}'`
      : "";

    // Aggregate amounts per UEI (CSV string avoids DuckDB LIST binding quirks)
    const sql = `
      SELECT
        UPPER(TRIM(CAST(uei AS VARCHAR))) AS uei,
        ANY_VALUE(recipient_name) AS recipient_name,
        ANY_VALUE(city) AS city,
        ANY_VALUE(county) AS county,
        UPPER(TRIM(CAST(state_code AS VARCHAR))) AS state_code,
        STRING_AGG(CAST(amount AS VARCHAR), '|') AS amounts_csv,
        STRING_AGG(DISTINCT CAST(cfda_number AS VARCHAR), '|') AS cfdas_csv,
        COUNT(*) AS txn_rows,
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS grant_pos
      FROM awards_grants
      WHERE uei IS NOT NULL
        AND TRIM(CAST(uei AS VARCHAR)) <> ''
        AND state_code IS NOT NULL
        AND TRIM(CAST(state_code AS VARCHAR)) <> ''
        ${stateFilter}
      GROUP BY 1, 5
    `;

    const rows = await db.all<Record<string, unknown>>(sql);
    const facilities: BulkScoredFacility[] = [];
    let scored = 0;
    let insufficient = 0;
    let withFac = 0;
    let withSam = 0;

    // Prefetch FAC map
    const facRows = await db.all<Record<string, unknown>>(`
      SELECT * FROM fac_latest
      WHERE auditee_uei IS NOT NULL
    `);
    const facByUei = new Map<string, Record<string, unknown>>();
    for (const r of facRows) {
      const u = String(r.auditee_uei ?? "")
        .trim()
        .toUpperCase();
      if (u) facByUei.set(u, r);
    }

    for (const r of rows) {
      const uei = String(r.uei ?? "").trim().toUpperCase();
      if (!uei) continue;
      const name = String(r.recipient_name ?? "Unknown").trim() || "Unknown";
      const state = String(r.state_code ?? "").trim().toUpperCase();
      if (!state) continue;

      const amounts = parseAmounts(
        r.amounts_csv != null
          ? String(r.amounts_csv)
              .split("|")
              .map((x) => Number(x))
          : r.amounts,
      );
      const cfdaList = parseStringList(
        r.cfdas_csv != null
          ? String(r.cfdas_csv).split("|")
          : r.cfdas,
      );

      let types = classifyFacilityTypes(name, cfdaList);
      if (cfg.onlyType && cfg.onlyType !== "all") {
        if (!types.includes(cfg.onlyType)) continue;
        types = [cfg.onlyType];
      }

      const pos = positiveAmounts(amounts);
      // Evidence: any non-zero finite obligation (includes de-obligations for n)
      const nonzero = amounts.filter((a) => Number.isFinite(a) && a !== 0);
      const sampleCount = Math.max(pos.length, nonzero.length);
      const insufficientRow = sampleCount < cfg.minEvidenceN;

      const facRow = facByUei.get(uei) ?? null;
      const fac = facFromRow(uei, facRow);
      if (fac) withFac += 1;

      let samInfo = {
        found: false,
        excluded: false,
        riskScore: 0,
        registrationAgeDays: null as number | null,
        legalBusinessName: null as string | null,
      };
      try {
        samInfo = samFromExtracts(uei);
      } catch (err) {
        console.warn(
          "[bulkScore] SAM extract lookup failed",
          uei,
          err instanceof Error ? err.message : err,
        );
      }
      if (samInfo.found) withSam += 1;

      const scoredParts = scoreRecipient({
        amounts,
        fac,
        excluded: samInfo.excluded,
      });

      if (insufficientRow) {
        insufficient += 1;
      } else if (scoredParts.fraudChance != null) {
        scored += 1;
      }

      const primaryCfda =
        cfdaList.find((c) => c && c !== "null") ?? null;

      facilities.push({
        id: uei,
        uei,
        recipientId: usaspendingRecipientIdFromUei(uei, "C"),
        name,
        city: r.city != null ? String(r.city) : null,
        county: r.county != null ? String(r.county) : null,
        state,
        types,
        grantReceived: pos.reduce((a, b) => a + b, 0),
        awardCount: sampleCount,
        sampleCount,
        amounts: pos,
        primaryCfda,
        fraudChance: insufficientRow ? null : scoredParts.fraudChance,
        fraudLabel: insufficientRow
          ? "insufficient"
          : scoredParts.fraudLabel,
        confidence: insufficientRow ? "none" : scoredParts.confidence,
        scoreMethod: insufficientRow ? "none" : scoredParts.scoreMethod,
        multiScore: insufficientRow ? null : scoredParts.multiScore,
        benfordScore: scoredParts.benfordScore,
        signals: scoredParts.signals,
        avgAward: scoredParts.avgAward,
        benfordEligible: scoredParts.benfordEligible,
        enrichment: {
          fac: fac
            ? {
                found: fac.found,
                riskScore: fac.riskScore,
                findingsCount: fac.findingsCount,
                materialWeakness: fac.materialWeakness,
                goingConcern: fac.goingConcern,
                lowRiskAuditee: fac.lowRiskAuditee,
                reportId: fac.reportId,
                auditYear: fac.auditYear,
              }
            : null,
          // found=true only when public entity extract or exclusion list has UEI
          // → UI greys SAM links when found=false (opt-out / not in extract)
          sam: samInfo.found
            ? {
                found: true,
                riskScore: samInfo.riskScore,
                excluded: samInfo.excluded,
                registrationAgeDays: samInfo.registrationAgeDays,
                legalBusinessName: samInfo.legalBusinessName,
              }
            : null,
          subaward: null,
          temporal: null,
        },
        features: scoredParts.features,
        benford: scoredParts.benford,
        insufficient: insufficientRow,
      });
    }

    return {
      facilities,
      stats: {
        recipients: facilities.length,
        scored,
        insufficient,
        withFac,
        withSam,
      },
    };
  } finally {
    if (own) await db.close();
  }
}

/** Convert bulk scored row to API Facility for list responses. */
export function bulkToFacility(b: BulkScoredFacility): Facility {
  return {
    id: b.id,
    name: b.name,
    city: b.city,
    county: b.county,
    state: b.state,
    grantReceived: b.grantReceived,
    awardCount: b.awardCount,
    grantsHydrated: true,
    sampleCount: b.sampleCount,
    fraudChance: b.fraudChance,
    fraudLabel: b.fraudLabel,
    confidence: b.confidence,
    scoreMethod: b.scoreMethod,
    scoreStatus: "ok",
    benfordScore: b.benfordScore,
    multiScore: b.multiScore,
    signals: b.signals,
    avgAward: b.avgAward,
    primaryCfda: b.primaryCfda,
    awardTypes: [],
    uei: b.uei,
    recipientId: b.recipientId ?? usaspendingRecipientIdFromUei(b.uei ?? "", "C"),
    benfordEligible: b.benfordEligible,
    enrichment: b.enrichment,
    rescore: {
      scoreAmounts: b.amounts.slice(0, 80),
      awardTypes: [],
      usedTransactions: false,
      primaryCfda: b.primaryCfda,
      grantReceived: b.grantReceived,
      awardCount: b.awardCount,
    },
    benford: b.benford,
    features: b.features,
    deepScored: false,
  };
}
