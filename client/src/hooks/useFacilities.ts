import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FacilitiesResponse,
  Facility,
  FacilityFilters,
} from "../types";

/** One automatic retry only, then settle with best available score. */
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 800;
const DEFAULT_PAGE_SIZE = 20;

interface UseFacilitiesState {
  facilities: Facility[];
  meta: FacilitiesResponse["meta"] | null;
  loading: boolean;
  error: string | null;
  searched: boolean;
  /** Active search filters (for page changes). */
  activeFilters: FacilityFilters | null;
  search: (filters: FacilityFilters, page?: number) => Promise<void>;
  goToPage: (page: number) => Promise<void>;
  resetError: () => void;
}

export function useFacilities(): UseFacilitiesState {
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [meta, setMeta] = useState<FacilitiesResponse["meta"] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [activeFilters, setActiveFilters] = useState<FacilityFilters | null>(
    null,
  );
  const retryCounts = useRef<Map<string, number>>(new Map());
  const retrying = useRef<Set<string>>(new Set());
  const settled = useRef<Set<string>>(new Set());
  const requestId = useRef(0);

  const search = useCallback(async (filters: FacilityFilters, page = 1) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    setSearched(true);
    setActiveFilters(filters);
    retryCounts.current = new Map();
    retrying.current = new Set();
    settled.current = new Set();

    const params = new URLSearchParams();
    if (filters.state) params.set("state", filters.state);
    if (filters.city) params.set("city", filters.city);
    if (filters.county) params.set("county", filters.county);
    if (filters.type && filters.type !== "all") params.set("type", filters.type);
    if (filters.q) params.set("q", filters.q);
    params.set("page", String(Math.max(1, page)));
    params.set("pageSize", String(DEFAULT_PAGE_SIZE));

    try {
      const res = await fetch(`/api/facilities?${params.toString()}`);
      const data = await res.json();
      if (id !== requestId.current) return;
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "Could not load facilities.",
        );
      }
      const body = data as FacilitiesResponse;
      setFacilities(body.facilities);
      setMeta(body.meta);
    } catch (err) {
      if (id !== requestId.current) return;
      setFacilities([]);
      setMeta(null);
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again.",
      );
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  const goToPage = useCallback(
    async (page: number) => {
      if (!activeFilters) return;
      await search(activeFilters, page);
    },
    [activeFilters, search],
  );

  const rescoreOne = useCallback(async (facility: Facility) => {
    if (retrying.current.has(facility.id) || settled.current.has(facility.id)) {
      return;
    }
    if (!facility.rescore) {
      settled.current.add(facility.id);
      setFacilities((prev) =>
        prev.map((f) =>
          f.id === facility.id
            ? { ...f, scoreStatus: "ok" as const }
            : f,
        ),
      );
      return;
    }

    const attempts = retryCounts.current.get(facility.id) ?? 0;
    if (attempts >= MAX_RETRIES) {
      settled.current.add(facility.id);
      setFacilities((prev) =>
        prev.map((f) =>
          f.id === facility.id
            ? {
                ...f,
                scoreStatus: "ok" as const,
                failReasons: f.failReasons,
              }
            : f,
        ),
      );
      return;
    }

    retrying.current.add(facility.id);
    retryCounts.current.set(facility.id, attempts + 1);

    setFacilities((prev) =>
      prev.map((f) =>
        f.id === facility.id ? { ...f, scoreStatus: "retrying" as const } : f,
      ),
    );

    try {
      const res = await fetch("/api/facilities/rescore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ facility }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string" ? data.error : "Rescore failed",
        );
      }
      const updated = data.facility as Facility;
      settled.current.add(facility.id);
      setFacilities((prev) =>
        prev.map((f) =>
          f.id === facility.id
            ? { ...updated, scoreStatus: "ok" as const }
            : f,
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Rescore failed";
      settled.current.add(facility.id);
      setFacilities((prev) =>
        prev.map((f) =>
          f.id === facility.id
            ? {
                ...f,
                scoreStatus: "ok" as const,
                failReasons: [msg],
              }
            : f,
        ),
      );
    } finally {
      retrying.current.delete(facility.id);
    }
  }, []);

  useEffect(() => {
    const failed = facilities.filter(
      (f) =>
        f.scoreStatus === "failed" &&
        f.rescore &&
        !settled.current.has(f.id) &&
        (retryCounts.current.get(f.id) ?? 0) < MAX_RETRIES &&
        !retrying.current.has(f.id),
    );
    if (failed.length === 0) return;

    const timers = failed.map((f, i) =>
      window.setTimeout(() => {
        void rescoreOne(f);
      }, RETRY_DELAY_MS + i * 300),
    );

    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, [facilities, rescoreOne]);

  return {
    facilities,
    meta,
    loading,
    error,
    searched,
    activeFilters,
    search,
    goToPage,
    resetError: () => setError(null),
  };
}
