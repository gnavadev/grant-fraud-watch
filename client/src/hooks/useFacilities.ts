import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FacilitiesResponse,
  Facility,
  FacilityFilters,
} from "../types";

/** One automatic retry only, then settle with best available score. */
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 800;

interface UseFacilitiesState {
  facilities: Facility[];
  meta: FacilitiesResponse["meta"] | null;
  loading: boolean;
  error: string | null;
  searched: boolean;
  search: (filters: FacilityFilters) => Promise<void>;
  resetError: () => void;
}

export function useFacilities(): UseFacilitiesState {
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [meta, setMeta] = useState<FacilitiesResponse["meta"] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const retryCounts = useRef<Map<string, number>>(new Map());
  const retrying = useRef<Set<string>>(new Set());
  const settled = useRef<Set<string>>(new Set());

  const search = useCallback(async (filters: FacilityFilters) => {
    setLoading(true);
    setError(null);
    setSearched(true);
    retryCounts.current = new Map();
    retrying.current = new Set();
    settled.current = new Set();

    const params = new URLSearchParams();
    if (filters.state) params.set("state", filters.state);
    if (filters.city) params.set("city", filters.city);
    if (filters.county) params.set("county", filters.county);
    if (filters.type && filters.type !== "all") params.set("type", filters.type);
    if (filters.q) params.set("q", filters.q);

    try {
      const res = await fetch(`/api/facilities?${params.toString()}`);
      const data = await res.json();
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
      setFacilities([]);
      setMeta(null);
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

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
      // Settle with existing partial score, do not spin forever
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
      // Server always returns scoreStatus ok with best-effort score
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
      // Fall back to whatever score we already had (without failed enrichment)
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

  // Auto-retry each failed row once, then settle
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
    search,
    resetError: () => setError(null),
  };
}
