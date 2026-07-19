import { useEffect } from "react";
import type { Facility } from "../types";
import { formatCurrency, formatPercent } from "../lib/format";
import { facilityLinks } from "../lib/links";
import {
  BENFORD_EXPECTED,
  DigitBars,
  HorizontalBars,
  SizeSummaryBars,
} from "./charts/SimpleCharts";

interface Props {
  facility: Facility;
  onClose: () => void;
}

const SIGNAL_LABELS: {
  key: keyof NonNullable<Facility["signals"]>;
  label: string;
  plain: string;
}[] = [
  {
    key: "fac",
    label: "Federal audit flags",
    plain: "Issues noted in the official Single Audit (if any)",
  },
  {
    key: "sam",
    label: "Registration risk",
    plain: "Exclusions or a very new SAM registration",
  },
  {
    key: "subaward",
    label: "Pass-through pattern",
    plain: "How sub-grants are concentrated under this recipient",
  },
  {
    key: "temporal",
    label: "Timing pattern",
    plain: "Year-end bunching or lots of money taken back / modified",
  },
  {
    key: "volume",
    label: "Awards vs dollars",
    plain: "Unusual mix of how many awards vs how much money",
  },
  {
    key: "program",
    label: "Program scale",
    plain: "Average award size vs typical size for this federal program",
  },
  {
    key: "benford",
    label: "Digit pattern",
    plain: "Whether amount digits look natural (only when enough data)",
  },
  {
    key: "concentration",
    label: "Money concentration",
    plain: "Whether one amount dominates the rest",
  },
  {
    key: "dispersion",
    label: "Spread of amounts",
    plain: "How uneven the award sizes are",
  },
  {
    key: "modNoise",
    label: "Modifications",
    plain: "Share of negative / reverse transactions",
  },
  {
    key: "lastDigit",
    label: "Last-digit pattern",
    plain: "Odd patterns in ending digits (transaction data)",
  },
];

function riskWords(score: number | null): string {
  if (score == null) return "Not scored";
  if (score >= 67) return "Higher priority to review";
  if (score >= 34) return "Medium priority to review";
  return "Lower priority to review";
}

export function FacilityDeepDive({ facility: f, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const signalBars = SIGNAL_LABELS.map((s) => {
    const v = f.signals?.[s.key];
    if (v == null) return null;
    return {
      label: s.label,
      value: v,
      hint: s.plain,
    };
  }).filter(Boolean) as { label: string; value: number; hint: string }[];

  const links = facilityLinks(f);
  const score = f.fraudChance;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="deep-dive-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-stone-900/40 backdrop-blur-[2px]"
        aria-label="Close"
        onClick={onClose}
      />

      <div className="relative z-10 flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-stone-200 bg-white shadow-xl sm:rounded-2xl">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-stone-100 px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-orange-800">
              Deep dive
            </p>
            <h2
              id="deep-dive-title"
              className="mt-0.5 truncate text-lg font-bold text-stone-900"
              title={f.name}
            >
              {f.name}
            </h2>
            <p className="mt-1 text-sm text-stone-600">
              {[f.city, f.county, f.state].filter(Boolean).join(" · ") ||
                "Location not available"}
              {f.uei ? ` · UEI ${f.uei}` : " · UEI not resolved yet"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-stone-200 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-50"
          >
            Close
          </button>
        </header>

        <div className="space-y-6 overflow-y-auto px-5 py-4">
          {/* Summary cards */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label="Review priority"
              value={
                score != null ? formatPercent(score) : f.scoreStatus === "failed" || f.scoreStatus === "retrying" ? "…" : "N/A"
              }
              sub={riskWords(score)}
              emphasize
            />
            <StatCard
              label="Grant total"
              value={formatCurrency(f.grantReceived)}
              sub={`${f.awardCount} award${f.awardCount === 1 ? "" : "s"}`}
            />
            <StatCard
              label="Average award"
              value={
                f.avgAward != null ? formatCurrency(f.avgAward) : "—"
              }
              sub={f.primaryCfda ? `Program ${f.primaryCfda}` : "Program n/a"}
            />
            <StatCard
              label="Amount samples"
              value={String(f.sampleCount)}
              sub={
                f.deepScored ? "Includes transactions" : "From awards"
              }
            />
          </section>

          <p className="rounded-lg bg-orange-50 px-3 py-2 text-xs leading-relaxed text-stone-700">
            This score is for <strong>triage only</strong> (where a human might
            look next). It is <strong>not proof of fraud</strong>. Large, clean
            organizations can still look unusual on some charts.
          </p>

          {/* Risk factors chart */}
          <section>
            <h3 className="text-sm font-semibold text-stone-900">
              What is driving the score?
            </h3>
            <p className="mt-0.5 text-xs text-stone-500">
              Higher bars mean that signal looks more unusual. Hover a bar for a
              plain-language note.
            </p>
            <div className="mt-3 rounded-xl border border-stone-100 bg-stone-50/50 p-4">
              <HorizontalBars items={signalBars} />
            </div>
          </section>

          {/* Amount sizes */}
          <section>
            <h3 className="text-sm font-semibold text-stone-900">
              How big are the amounts?
            </h3>
            <p className="mt-0.5 text-xs text-stone-500">
              Smallest, average, and largest amounts used in scoring (same
              facility only).
            </p>
            <div className="mt-3 rounded-xl border border-stone-100 bg-stone-50/50 p-4">
              <SizeSummaryBars
                min={f.features?.min ?? 0}
                avg={f.features?.mean ?? f.avgAward ?? 0}
                max={f.features?.max ?? 0}
              />
            </div>
          </section>

          {/* Digit pattern — always shown; blend weight scales with n */}
          <section>
            <h3 className="text-sm font-semibold text-stone-900">
              Do the digits look natural?
            </h3>
            <p className="mt-0.5 text-xs text-stone-500">
              Real-world money often starts with 1 more than 9. Orange bars show
              a typical pattern; dark bars show this facility. Always displayed;
              how much it affects the score grows with sample size (weak under
              ~100; more useful near 300+).
            </p>
            <div className="mt-3 rounded-xl border border-stone-100 bg-stone-50/50 p-4">
              {f.benford?.digitCounts && (f.benford.sampleSize ?? 0) > 0 ? (
                <>
                  <DigitBars
                    observed={f.benford.digitCounts}
                    expected={BENFORD_EXPECTED}
                  />
                  <p className="mt-2 text-xs text-stone-500">
                    Based on {f.benford.sampleSize} amount
                    {f.benford.sampleSize === 1 ? "" : "s"}
                    {f.benford.sampleSize < 100
                      ? " — small sample, so this barely affects the overall score (mostly noise below ~100)."
                      : f.benford.sampleSize < 300
                        ? " — moderate sample; digit pattern has limited weight."
                        : " — large sample; digit pattern can weigh more (still secondary to audits/SAM)."}
                  </p>
                </>
              ) : (
                <p className="text-sm text-stone-500">
                  No positive amounts available to chart digits for this
                  facility. Other signals still apply.
                </p>
              )}
            </div>
          </section>

          {/* Enrichment flags */}
          <section>
            <h3 className="text-sm font-semibold text-stone-900">
              Official checks we looked at
            </h3>
            <ul className="mt-2 space-y-2 text-sm text-stone-700">
              <li className="rounded-lg border border-stone-100 px-3 py-2">
                <strong className="text-stone-900">Federal audit (FAC):</strong>{" "}
                {f.enrichment?.fac?.found
                  ? f.enrichment.fac.materialWeakness ||
                    f.enrichment.fac.goingConcern
                    ? "Audit flags present (weakness and/or going concern)."
                    : f.enrichment.fac.findingsCount > 0
                      ? `${f.enrichment.fac.findingsCount} finding(s) on record${
                          f.enrichment.fac.auditYear
                            ? ` (audit year ${f.enrichment.fac.auditYear})`
                            : ""
                        }.`
                      : f.enrichment.fac.lowRiskAuditee
                        ? "Audit on file; marked low-risk auditee."
                        : "Audit on file; no major flags in summary fields."
                  : f.uei
                    ? "No Single Audit on file for this UEI in FAC (under the $750K threshold, not required, or not filed)."
                    : "No UEI available to look up an audit."}
              </li>
              <li className="rounded-lg border border-stone-100 px-3 py-2">
                <strong className="text-stone-900">SAM.gov registration:</strong>{" "}
                {f.enrichment?.sam?.found
                  ? f.enrichment.sam.excluded
                    ? "Listed on an exclusion list (high priority)."
                    : f.enrichment.sam.registrationAgeDays != null
                      ? `Registered about ${Math.round(f.enrichment.sam.registrationAgeDays / 365)} year(s) (age in days: ${f.enrichment.sam.registrationAgeDays}).`
                      : "Entity found; no exclusion flag in our summary."
                  : f.uei
                    ? "Company opted out of public display, or no public SAM registration match for this UEI."
                    : "No UEI available for SAM lookup."}
              </li>
              <li className="rounded-lg border border-stone-100 px-3 py-2">
                <strong className="text-stone-900">Subawards:</strong>{" "}
                {f.enrichment?.subaward
                  ? `About ${Math.round(f.enrichment.subaward.topSubShare * 100)}% of tracked subaward dollars go to the top subrecipient (${f.enrichment.subaward.uniqueSubs} unique sub(s) seen).`
                  : "No concentrated pass-through pattern detected in this search sample."}
              </li>
            </ul>
          </section>

          {/* Links */}
          <section>
            <h3 className="text-sm font-semibold text-stone-900">
              Official links
            </h3>
            <p className="mt-0.5 text-xs text-stone-500">
              Opens government sites in a new tab so you can verify the data
              yourself.
            </p>
            <ul className="mt-3 space-y-2">
              {links.map((l) => (
                <li key={l.label}>
                  {l.available && l.href ? (
                    <a
                      href={l.href}
                      target="_blank"
                      rel="noreferrer"
                      className="flex flex-col rounded-lg border border-orange-100 bg-orange-50/60 px-3 py-2.5 transition hover:border-orange-300 hover:bg-orange-50 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                    >
                      <span className="font-semibold text-orange-950">
                        {l.label}
                      </span>
                      <span className="text-xs text-stone-600">
                        {l.description}
                      </span>
                    </a>
                  ) : (
                    <div
                      className="flex cursor-not-allowed flex-col rounded-lg border border-stone-200 bg-stone-100/80 px-3 py-2.5 opacity-60 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                      aria-disabled="true"
                      title={l.description}
                    >
                      <span className="font-semibold text-stone-500">
                        {l.label}
                      </span>
                      <span className="text-xs text-stone-400">
                        {l.description}
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  emphasize,
}: {
  label: string;
  value: string;
  sub: string;
  emphasize?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border px-3 py-2.5 ${
        emphasize
          ? "border-orange-200 bg-orange-50"
          : "border-stone-100 bg-stone-50/80"
      }`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
        {label}
      </p>
      <p className="mt-0.5 text-base font-bold tabular-nums text-stone-900">
        {value}
      </p>
      <p className="text-[11px] leading-snug text-stone-500">{sub}</p>
    </div>
  );
}
