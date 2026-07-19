import type { Facility } from "../types";
import { formatPercent } from "../lib/format";

interface Props {
  facility: Facility;
}

function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin text-orange-700"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z"
      />
    </svg>
  );
}

export function FraudBadge({ facility }: Props) {
  // Only spin while a retry is in flight, never stick on "failed"
  if (facility.scoreStatus === "retrying") {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-orange-50 px-2.5 py-1 text-xs font-medium text-orange-900 ring-1 ring-inset ring-orange-200"
        title="Retrying enrichment..."
      >
        <Spinner />
        <span>Retrying</span>
      </span>
    );
  }

  // failed without having settled yet → show spinner (auto-retry about to run)
  if (facility.scoreStatus === "failed") {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-orange-50 px-2.5 py-1 text-xs font-medium text-orange-900 ring-1 ring-inset ring-orange-200"
        title={
          facility.failReasons?.join(" · ") ||
          "Enrichment failed, retrying once..."
        }
      >
        <Spinner />
        <span>Retrying</span>
      </span>
    );
  }

  if (facility.fraudChance == null || facility.confidence === "none") {
    return (
      <span
        className="inline-flex items-center rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600 ring-1 ring-inset ring-stone-200"
        title={
          facility.failReasons?.join(" · ") ||
          "Not enough data to score this facility."
        }
      >
        N/A
      </span>
    );
  }

  const riskStyles =
    facility.fraudLabel === "low"
      ? "bg-emerald-50 text-emerald-900 ring-emerald-200"
      : facility.fraudLabel === "medium"
        ? "bg-amber-50 text-amber-950 ring-amber-200"
        : "bg-red-50 text-red-900 ring-red-200";

  const riskLabel =
    facility.fraudLabel === "low"
      ? "Low"
      : facility.fraudLabel === "medium"
        ? "Medium"
        : "High";

  const partialNote =
    facility.failReasons && facility.failReasons.length > 0
      ? ` · ${facility.failReasons.join(" · ")}`
      : "";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${riskStyles}`}
      title={`Audit-worthiness score, not proof of fraud.${partialNote}`}
    >
      <span className="tabular-nums">{formatPercent(facility.fraudChance)}</span>
      <span className="font-medium opacity-80">{riskLabel}</span>
    </span>
  );
}
