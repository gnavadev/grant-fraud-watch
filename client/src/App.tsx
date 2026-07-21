import { useMemo, useState } from "react";
import { ColdStartBanner } from "./components/ColdStartBanner";
import { EmptyState } from "./components/EmptyState";
import { FacilitiesTable } from "./components/FacilitiesTable";
import { FacilityDeepDive } from "./components/FacilityDeepDive";
import { FilterBar } from "./components/FilterBar";
import { useFacilities } from "./hooks/useFacilities";
import type { FacilityFilters } from "./types";

const initialFilters: FacilityFilters = {
  state: "",
  city: "",
  county: "",
  type: "all",
  q: "",
};

export default function App() {
  const [filters, setFilters] = useState<FacilityFilters>(initialFilters);
  const { facilities, meta, loading, error, searched, search, goToPage } =
    useFacilities();
  const [helpOpen, setHelpOpen] = useState(false);
  const [hideInsufficient, setHideInsufficient] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedFacility = useMemo(
    () => facilities.find((f) => f.id === selectedId) ?? null,
    [facilities, selectedId],
  );

  function handleSearch() {
    setSelectedId(null);
    void search(filters, 1);
  }

  function handleServerPage(page: number) {
    setSelectedId(null);
    void goToPage(page);
  }

  return (
    <div className="mx-auto min-h-screen max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold uppercase tracking-widest text-orange-800 sm:text-3xl">
              USAspending explorer
            </h1>
          </div>
          <button
            type="button"
            onClick={() => setHelpOpen((v) => !v)}
            className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm font-medium text-stone-700 shadow-sm hover:bg-orange-50"
          >
            {helpOpen ? "Hide help" : "How this works"}
          </button>
        </div>

        {helpOpen && (
          <div className="mt-4 space-y-3 rounded-xl border border-orange-100 bg-orange-50/90 px-4 py-3 text-sm text-stone-700">
            <div>
              <p className="font-semibold text-stone-900">How this works</p>
              <p className="mt-1 leading-relaxed text-stone-600">
                This is an <strong>audit-worthiness</strong> ranking, not a
                measure of proven fraud. Each facility is scored from its own
                federal data plus public administrative risk sources. Facilities
                are not ranked against each other in your search.
              </p>
            </div>

            <div>
              <p className="font-semibold text-stone-900">Primary signals</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 leading-relaxed">
                <li>
                  <strong>FAC (Federal Audit Clearinghouse):</strong> Single
                  Audit flags such as material weaknesses, going concern,
                  noncompliance, findings counts, and low-risk auditee status
                  (joined on UEI).
                </li>
                <li>
                  <strong>SAM.gov:</strong> exclusion/debarment lists and entity
                  registration age (very new registrants with large awards are a
                  stronger shell-company signal than digit tests).
                </li>
                <li>
                  <strong>Subawards (USAspending FSRS):</strong> pass-through
                  concentration (e.g. almost all dollars to one subrecipient).
                </li>
                <li>
                  <strong>Temporal structure:</strong> end-of-fiscal-year
                  clustering, de-obligation share, and modification churn from
                  transaction history.
                </li>
              </ul>
            </div>

            <div>
              <p className="font-semibold text-stone-900">Secondary math signals</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 leading-relaxed">
                <li>
                  <strong>Benford / last-digit:</strong> digit chart for every
                  facility with amounts. Blend weight grows with sample size
                  (logistic): weak under ~100 records, stronger near 300+
                  (Nigrini). Grant caps still make digit tests secondary.
                </li>
                <li>
                  <strong>Round-number flags on awards:</strong> off. Grant
                  budgets are supposed to be round.
                </li>
                <li>
                  <strong>Volume / CFDA program scale / concentration:</strong>
                  absolute structure checks on this facility's awards only.
                </li>
              </ul>
            </div>

            <div>
              <p className="font-semibold text-stone-900">Data notes</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 leading-relaxed">
                <li>
                  Awards and transactions from USAspending.gov; audits from
                  fac.gov; entity data from SAM.gov. Grant counts are the
                  recipient&apos;s full grant list for the last ~10 years (not
                  only the search sample).
                </li>
                <li>
                  State government spending systems are not integrated (different
                  or missing APIs / Excel dumps).
                </li>
              </ul>
            </div>

            <p className="text-xs font-medium text-stone-600">
              Not proof of fraud. Use only to decide where a human auditor should
              look next. Data:{" "}
              <a
                className="text-orange-800 underline hover:text-orange-950"
                href="https://www.usaspending.gov"
                target="_blank"
                rel="noreferrer"
              >
                USAspending
              </a>
              ,{" "}
              <a
                className="text-orange-800 underline hover:text-orange-950"
                href="https://www.fac.gov"
                target="_blank"
                rel="noreferrer"
              >
                FAC
              </a>
              ,{" "}
              <a
                className="text-orange-800 underline hover:text-orange-950"
                href="https://sam.gov"
                target="_blank"
                rel="noreferrer"
              >
                SAM.gov
              </a>
              .
            </p>
          </div>
        )}
      </header>

      <div className="space-y-5">
        <ColdStartBanner />
        <FilterBar
          value={filters}
          onChange={setFilters}
          onSearch={handleSearch}
          loading={loading}
        />

        {meta && !error && (
          <p className="text-sm text-stone-600">
            Found{" "}
            <strong className="text-stone-900">{meta.facilityCount}</strong>{" "}
            facilities from{" "}
            <strong className="text-stone-900">{meta.awardCount}</strong> grant
            awards
            {meta.totalPages > 1 ? (
              <>
                {" "}
                · showing page{" "}
                <strong className="text-stone-900">{meta.page}</strong> of{" "}
                <strong className="text-stone-900">{meta.totalPages}</strong>
                {" "}
                ({meta.scoredCount} scored on this page)
              </>
            ) : meta.scoredCount < facilities.length ? (
              <> ({meta.scoredCount} scored)</>
            ) : null}
            .
            {meta.cache?.response ? (
              <span className="text-stone-400"> · cached</span>
            ) : null}
            {" "}
            <span className="text-stone-400">
              {meta.bulk
                ? "Offline bulk ranking (USAspending archive + FAC). Ranked by audit-worthiness among scored recipients in this state/type."
                : "Ranked by audit-worthiness among facilities in this search. Grant counts marked · sample are from the live sample."}
            </span>
          </p>
        )}

        {error && (
          <EmptyState
            variant="error"
            message={error}
            onRetry={handleSearch}
          />
        )}

        {!error && !searched && !loading && <EmptyState variant="welcome" />}

        {!error && (searched || loading) && (
          <FacilitiesTable
            facilities={facilities}
            loading={loading}
            hideInsufficient={hideInsufficient}
            onHideInsufficientChange={setHideInsufficient}
            onSelectFacility={(f) => setSelectedId(f.id)}
            serverPage={meta?.page}
            serverTotalPages={meta?.totalPages}
            serverTotalCount={meta?.facilityCount}
            onServerPageChange={handleServerPage}
            pageLoading={loading && facilities.length > 0}
          />
        )}
      </div>

      <footer className="mt-10 border-t border-stone-200/80 pt-6 text-center text-xs text-stone-400">
        <p>Data from USAspending.gov</p>
        <p className="mt-3 flex flex-wrap items-center justify-center">
          <a
            href="https://www.linkedin.com/in/gabriel-nava-dev/"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-stone-600 shadow-sm transition hover:border-orange-200 hover:text-orange-800"
            title="LinkedIn"
          >
            <svg
              className="h-4 w-4 shrink-0"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden
            >
              <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
            </svg>
            <span>LinkedIn</span>
          </a>
        </p>
      </footer>

      {selectedFacility && (
        <FacilityDeepDive
          facility={selectedFacility}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
