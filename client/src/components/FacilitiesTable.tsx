import { useMemo, useState } from "react";
import type { Facility, SortKey, SortSpec } from "../types";
import { dash, formatCurrency } from "../lib/format";
import { cycleSort, multiSortFacilities } from "../lib/multiSort";
import { FraudBadge } from "./FraudBadge";
import { SortHeader } from "./SortHeader";

interface Props {
  facilities: Facility[];
  loading: boolean;
  hideInsufficient: boolean;
  onHideInsufficientChange: (value: boolean) => void;
  onSelectFacility: (facility: Facility) => void;
  /** Server-side page (1-based). When set, Next/Prev fetch from API. */
  serverPage?: number;
  serverTotalPages?: number;
  serverTotalCount?: number;
  onServerPageChange?: (page: number) => void;
  pageLoading?: boolean;
}

export function FacilitiesTable({
  facilities,
  loading,
  hideInsufficient,
  onHideInsufficientChange,
  onSelectFacility,
  serverPage,
  serverTotalPages,
  serverTotalCount,
  onServerPageChange,
  pageLoading,
}: Props) {
  const [sorts, setSorts] = useState<SortSpec[]>([
    { key: "fraudChance", dir: "desc" },
    { key: "grantReceived", dir: "desc" },
  ]);

  const filtered = useMemo(() => {
    if (!hideInsufficient) return facilities;
    return facilities.filter((f) => f.fraudChance != null);
  }, [facilities, hideInsufficient]);

  const sorted = useMemo(
    () => multiSortFacilities(filtered, sorts),
    [filtered, sorts],
  );

  const useServerPaging =
    typeof serverPage === "number" &&
    typeof serverTotalPages === "number" &&
    serverTotalPages >= 1 &&
    typeof onServerPageChange === "function";

  const safePage = useServerPaging
    ? Math.min(Math.max(1, serverPage!), Math.max(1, serverTotalPages!))
    : 1;
  const totalPages = useServerPaging ? Math.max(1, serverTotalPages!) : 1;
  const pageRows = sorted;
  const totalCount = useServerPaging
    ? (serverTotalCount ?? sorted.length)
    : sorted.length;

  const insufficientCount = facilities.filter(
    (f) => f.fraudChance == null,
  ).length;

  function handleSort(key: SortKey) {
    setSorts((prev) => cycleSort(prev, key));
  }

  if (loading && facilities.length === 0) {
    return <TableSkeleton />;
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-sm shadow-stone-200/50">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-100 bg-stone-50/70 px-4 py-3">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-stone-700">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-stone-300 text-orange-700 focus:ring-orange-500"
            checked={hideInsufficient}
            onChange={(e) => {
              onHideInsufficientChange(e.target.checked);
            }}
          />
          Hide unscored on this page
          {insufficientCount > 0 && (
            <span className="text-xs text-stone-500">
              ({insufficientCount})
            </span>
          )}
        </label>
        <p className="text-xs text-stone-500">
          Click a row for a deep dive
          {useServerPaging ? " · pages load scores in batches" : ""}
        </p>
      </div>

      <div
        className={`overflow-x-auto ${pageLoading ? "opacity-60 pointer-events-none" : ""}`}
      >
        <table className="min-w-full divide-y divide-stone-100 text-sm">
          <thead className="bg-stone-50/90">
            <tr>
              <SortHeader
                label="Facility"
                sortKey="name"
                sorts={sorts}
                onSort={handleSort}
              />
              <SortHeader
                label="City"
                sortKey="city"
                sorts={sorts}
                onSort={handleSort}
              />
              <SortHeader
                label="County"
                sortKey="county"
                sorts={sorts}
                onSort={handleSort}
              />
              <SortHeader
                label="State"
                sortKey="state"
                sorts={sorts}
                onSort={handleSort}
              />
              <SortHeader
                label="Grant received"
                sortKey="grantReceived"
                sorts={sorts}
                onSort={handleSort}
                align="right"
              />
              <SortHeader
                label="Fraud chance"
                sortKey="fraudChance"
                sorts={sorts}
                onSort={handleSort}
                hint="Click to sort this page by fraud chance."
              />
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {pageRows.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-12 text-center text-stone-500"
                >
                  {hideInsufficient
                    ? 'No scored facilities on this page. Try turning off "Hide unscored".'
                    : "No facilities match these filters."}
                </td>
              </tr>
            ) : (
              pageRows.map((f) => (
                <tr
                  key={f.id}
                  className="cursor-pointer transition hover:bg-orange-50/70"
                  onClick={() => onSelectFacility(f)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectFacility(f);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open deep dive for ${f.name}`}
                >
                  <td className="max-w-xs px-4 py-3 font-medium text-stone-900">
                    <div className="truncate" title={f.name}>
                      {f.name}
                    </div>
                    <div
                      className="mt-0.5 text-xs font-normal text-stone-400"
                      title={
                        f.grantsHydrated
                          ? "All federal grants to this recipient in the last ~10 years (USAspending)"
                          : "From this search sample only, full grant list not loaded (API busy or failed). Count may be low."
                      }
                    >
                      {f.awardCount} grant{f.awardCount === 1 ? "" : "s"}
                      {!f.grantsHydrated ? (
                        <span className="text-stone-400"> · sample</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-stone-700">
                    {dash(f.city)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-stone-700">
                    {dash(f.county)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-stone-700">
                    {dash(f.state)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums font-medium text-stone-900">
                    {formatCurrency(f.grantReceived)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <FraudBadge facility={f} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {useServerPaging && totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-100 bg-stone-50/60 px-4 py-3 text-sm text-stone-600">
          <span>
            Page {safePage} of {totalPages}
            {totalCount > 0 ? (
              <>
                {" "}
                · {totalCount} facilities total
              </>
            ) : null}
            {pageLoading ? (
              <span className="ml-2 text-stone-400">Loading…</span>
            ) : null}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 font-medium hover:bg-orange-50 disabled:opacity-40"
              disabled={safePage <= 1 || pageLoading}
              onClick={() => onServerPageChange!(safePage - 1)}
            >
              Previous
            </button>
            <span className="tabular-nums text-stone-500">
              {safePage} / {totalPages}
            </span>
            <button
              type="button"
              className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 font-medium hover:bg-orange-50 disabled:opacity-40"
              disabled={safePage >= totalPages || pageLoading}
              onClick={() => onServerPageChange!(safePage + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm">
      <div className="space-y-3 animate-pulse">
        <div className="h-10 rounded-lg bg-stone-100" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-12 rounded-lg bg-stone-50" />
        ))}
      </div>
      <p className="mt-4 text-center text-sm text-stone-500">
        Loading grant data (page 1)…
      </p>
    </div>
  );
}
