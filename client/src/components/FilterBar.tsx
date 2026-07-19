import type { FormEvent } from "react";
import type { FacilityFilters, FacilityTypeKey } from "../types";
import { FACILITY_TYPE_OPTIONS, US_STATES } from "../lib/states";

interface Props {
  value: FacilityFilters;
  onChange: (next: FacilityFilters) => void;
  onSearch: () => void;
  loading: boolean;
}

const fieldClass =
  "w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 shadow-sm outline-none transition placeholder:text-stone-400 focus:border-orange-400 focus:ring-2 focus:ring-orange-100";

const labelClass =
  "mb-1 block text-xs font-semibold uppercase tracking-wide text-stone-500";

export function FilterBar({ value, onChange, onSearch, loading }: Props) {
  function update<K extends keyof FacilityFilters>(
    key: K,
    next: FacilityFilters[K],
  ) {
    onChange({ ...value, [key]: next });
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSearch();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-stone-200/80 bg-white/95 p-4 shadow-sm shadow-stone-200/50 sm:p-5"
    >
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-stone-800">Filters</h2>
        <p className="text-xs text-stone-500">
          Choose a state, facility type, or search term, then press Search.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <div>
          <label htmlFor="filter-state" className={labelClass}>
            State
          </label>
          <select
            id="filter-state"
            className={fieldClass}
            value={value.state}
            onChange={(e) => update("state", e.target.value)}
          >
            <option value="">All states</option>
            {US_STATES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="filter-city" className={labelClass}>
            City
          </label>
          <input
            id="filter-city"
            className={fieldClass}
            value={value.city}
            onChange={(e) => update("city", e.target.value)}
            placeholder="e.g. Houston"
            autoComplete="address-level2"
          />
        </div>

        <div>
          <label htmlFor="filter-county" className={labelClass}>
            County
          </label>
          <input
            id="filter-county"
            className={fieldClass}
            value={value.county}
            onChange={(e) => update("county", e.target.value)}
            placeholder="e.g. Harris"
            autoComplete="off"
          />
        </div>

        <div>
          <label htmlFor="filter-type" className={labelClass}>
            Facility type
          </label>
          <select
            id="filter-type"
            className={fieldClass}
            value={value.type}
            onChange={(e) =>
              update("type", e.target.value as FacilityTypeKey)
            }
          >
            {FACILITY_TYPE_OPTIONS.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div className="sm:col-span-2 lg:col-span-1 xl:col-span-1">
          <label htmlFor="filter-q" className={labelClass}>
            Search text
          </label>
          <input
            id="filter-q"
            className={fieldClass}
            value={value.q}
            onChange={(e) => update("q", e.target.value)}
            placeholder="Facility name..."
            autoComplete="off"
          />
        </div>

        <div className="flex items-end sm:col-span-2 lg:col-span-3 xl:col-span-1">
          <button
            type="submit"
            disabled={loading}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-orange-700 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-orange-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-orange-400"
          >
            {loading ? (
              <>
                <Spinner />
                Searching...
              </>
            ) : (
              <>
                <SearchIcon />
                Search
              </>
            )}
          </button>
        </div>
      </div>
    </form>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
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
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3-3" strokeLinecap="round" />
    </svg>
  );
}
