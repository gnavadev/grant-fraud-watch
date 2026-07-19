import { useEffect, useState } from "react";

type Health = {
  ok: boolean;
  facKey?: boolean;
  samKey?: boolean;
  notes?: string[];
  uptimeSec?: number;
  samQuotaBlocked?: boolean;
  samQuotaUntil?: string | null;
};

/**
 * Free hosts (Render) spin down after idle. First request can take ~30–60s.
 * Ping /api/health on load; if it is slow, show a friendly waking banner.
 */
export function ColdStartBanner() {
  const [phase, setPhase] = useState<
    "checking" | "waking" | "ready" | "error"
  >("checking");
  const [health, setHealth] = useState<Health | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const started = Date.now();
    const tick = window.setInterval(() => {
      if (!cancelled) setElapsedSec(Math.floor((Date.now() - started) / 1000));
    }, 500);

    // Show "waking" only if health is still pending after 2s
    const wakeTimer = window.setTimeout(() => {
      if (!cancelled) {
        setPhase((p) => (p === "checking" ? "waking" : p));
      }
    }, 2000);

    const controller = new AbortController();
    const hardTimeout = window.setTimeout(() => controller.abort(), 90_000);

    fetch("/api/health", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Health ${res.status}`);
        return (await res.json()) as Health;
      })
      .then((data) => {
        if (cancelled) return;
        setHealth(data);
        setPhase("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setPhase("error");
      })
      .finally(() => {
        window.clearTimeout(wakeTimer);
        window.clearTimeout(hardTimeout);
        window.clearInterval(tick);
      });

    return () => {
      cancelled = true;
      window.clearTimeout(wakeTimer);
      window.clearTimeout(hardTimeout);
      window.clearInterval(tick);
      controller.abort();
    };
  }, []);

  if (phase === "ready" || phase === "checking") {
    // Key warnings only once ready (no keys set on deploy)
    if (phase === "ready" && health) {
      const showKeys = health.facKey === false || health.samKey === false;
      const showQuota = health.samQuotaBlocked === true;
      if (!showKeys && !showQuota) return null;

      return (
        <div
          className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
          role="status"
        >
          <p className="font-semibold">
            {showQuota ? "SAM rate limit" : "API keys incomplete"}
          </p>
          <ul className="mt-1 list-disc pl-5 text-amber-900/90">
            {showQuota && (
              <li>
                SAM.gov daily quota reached
                {health.samQuotaUntil
                  ? `, lookups are paused until ${new Date(health.samQuotaUntil).toLocaleString()}`
                  : ", lookups are paused"}
                . Cached SAM data still works; other scores are unchanged.
              </li>
            )}
            {!health.facKey && (
              <li>
                FAC key missing, Single Audit enrichment is off. Set{" "}
                <code className="text-xs">FAC_API_KEY</code> on the host.
              </li>
            )}
            {!health.samKey && (
              <li>
                SAM key missing or expired (~90 days), set{" "}
                <code className="text-xs">SAM_API_KEY</code> on the host
                (SAM Account Details, not Data.gov).
              </li>
            )}
          </ul>
        </div>
      );
    }
    return null;
  }

  if (phase === "waking") {
    return (
      <div
        className="mb-4 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-950"
        role="status"
        aria-live="polite"
      >
        <p className="font-semibold">Waking up the free server…</p>
        <p className="mt-1 text-orange-900/90">
          Free hosts sleep after idle time. First load can take about a minute
          {elapsedSec > 0 ? ` (${elapsedSec}s so far)` : ""}. This is normal,
          not a bug.
        </p>
      </div>
    );
  }

  // error
  return (
    <div
      className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-950"
      role="alert"
    >
      <p className="font-semibold">Could not reach the API</p>
      <p className="mt-1 text-red-900/90">
        The server may still be starting, or the deploy is down. Wait a moment
        and refresh the page.
      </p>
    </div>
  );
}
