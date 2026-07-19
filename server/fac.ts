import { cacheGet, cacheSet } from "./cache.js";
import { getFacApiKey } from "./env.js";
import { log } from "./logger.js";

const FAC_BASE = "https://api.fac.gov";

export interface FacAuditSummary {
  uei: string;
  found: boolean;
  auditYear: number | null;
  goingConcern: boolean;
  materialWeakness: boolean;
  significantDeficiency: boolean;
  materialNoncompliance: boolean;
  lowRiskAuditee: boolean;
  priorFindingsAgencyCount: number;
  totalExpended: number | null;
  findingsCount: number;
  /** 0–100 risk contribution from FAC. */
  riskScore: number;
  reportId: string | null;
}

function yes(v: unknown): boolean {
  if (v === true) return true;
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return s === "yes" || s === "y" || s === "true" || s === "1";
}

function scoreFromFac(row: Record<string, unknown>, findingsCount: number): number {
  let score = 0;
  if (yes(row.is_going_concern_included)) score += 35;
  if (yes(row.is_internal_control_material_weakness_disclosed)) score += 30;
  if (yes(row.is_material_noncompliance_disclosed)) score += 25;
  if (yes(row.is_internal_control_deficiency_disclosed)) score += 15;
  if (!yes(row.is_low_risk_auditee) && row.is_low_risk_auditee != null) score += 10;

  const prior = String(row.agencies_with_prior_findings ?? "00");
  if (prior && prior !== "00" && prior !== "0" && prior !== "") score += 20;

  if (findingsCount >= 1) score += Math.min(30, findingsCount * 10);

  return Math.min(100, score);
}

export type FacLookup =
  | { status: "ok"; data: FacAuditSummary }
  | { status: "error"; message: string }
  | { status: "skipped" };

/**
 * Latest Single Audit summary for a UEI from Federal Audit Clearinghouse.
 * Requires FAC_API_KEY / api.data.gov key.
 * Errors are not cached so retries can succeed.
 */
export async function fetchFacByUei(uei: string): Promise<FacLookup> {
  const key = getFacApiKey();
  if (!key || !uei?.trim()) return { status: "skipped" };

  const clean = uei.trim().toUpperCase();
  const cacheKey = `fac_${clean}`;
  const cached = await cacheGet<FacAuditSummary>(cacheKey, 24 * 60 * 60 * 1000);
  if (cached) return { status: "ok", data: cached };

  try {
    const url =
      `${FAC_BASE}/general?auditee_uei=eq.${encodeURIComponent(clean)}` +
      `&order=audit_year.desc&limit=3`;
    const res = await fetch(url, {
      headers: { "X-Api-Key": key, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      log.warn("fac_http_error", { uei: clean, status: res.status });
      return { status: "error", message: `FAC HTTP ${res.status}` };
    }
    const rows = (await res.json()) as Record<string, unknown>[];
    if (!Array.isArray(rows) || rows.length === 0) {
      const empty: FacAuditSummary = {
        uei: clean,
        found: false,
        auditYear: null,
        goingConcern: false,
        materialWeakness: false,
        significantDeficiency: false,
        materialNoncompliance: false,
        lowRiskAuditee: true,
        priorFindingsAgencyCount: 0,
        totalExpended: null,
        findingsCount: 0,
        riskScore: 0,
        reportId: null,
      };
      await cacheSet(cacheKey, empty);
      return { status: "ok", data: empty };
    }

    const row = rows[0];
    let findingsCount = 0;
    try {
      const fUrl =
        `${FAC_BASE}/federal_awards?auditee_uei=eq.${encodeURIComponent(clean)}` +
        `&report_id=eq.${encodeURIComponent(String(row.report_id ?? ""))}` +
        `&limit=50`;
      const fRes = await fetch(fUrl, {
        headers: { "X-Api-Key": key, Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (fRes.ok) {
        const awards = (await fRes.json()) as { findings_count?: number }[];
        if (Array.isArray(awards)) {
          findingsCount = awards.reduce(
            (s, a) => s + (Number(a.findings_count) || 0),
            0,
          );
        }
      }
    } catch {
      /* optional nested */
    }

    const prior = String(row.agencies_with_prior_findings ?? "00");
    const summary: FacAuditSummary = {
      uei: clean,
      found: true,
      auditYear: row.audit_year != null ? Number(row.audit_year) : null,
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
      riskScore: scoreFromFac(row, findingsCount),
      reportId: row.report_id != null ? String(row.report_id) : null,
    };
    await cacheSet(cacheKey, summary);
    return { status: "ok", data: summary };
  } catch (err) {
    log.warn("fac_error", { uei: clean, err });
    return {
      status: "error",
      message: err instanceof Error ? err.message : "FAC request failed",
    };
  }
}
