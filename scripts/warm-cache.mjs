/**
 * Warm prod (or any base URL) by hitting popular /api/facilities searches.
 * Fills Redis: awards cache, page response cache, facility score map.
 *
 * Usage:
 *   BASE_URL=https://grant-fraud-watch.onrender.com node scripts/warm-cache.mjs
 *   node scripts/warm-cache.mjs --base https://...
 *
 * Env:
 *   WARM_BASE_URL / BASE_URL  — default https://grant-fraud-watch.onrender.com
 *   WARM_TIMEOUT_MS           — per-request timeout (default 180000)
 *   WARM_DELAY_MS             — pause between requests (default 2000)
 */

const DEFAULT_BASE = "https://grant-fraud-watch.onrender.com";

/** Popular filters: keep short so free CI + Render stay healthy. */
const QUERIES = [
  { state: "CA", type: "healthcare", page: 1 },
  { state: "CA", type: "healthcare", page: 2 },
  { state: "TX", type: "healthcare", page: 1 },
  { state: "NY", type: "healthcare", page: 1 },
  { state: "FL", type: "healthcare", page: 1 },
  { state: "CA", type: "education", page: 1 },
  { state: "TX", type: "education", page: 1 },
  { state: "CA", type: "daycare", page: 1 },
  { state: "NY", type: "housing", page: 1 },
  { state: "IL", type: "healthcare", page: 1 },
];

function parseArgs(argv) {
  let base = process.env.WARM_BASE_URL || process.env.BASE_URL || DEFAULT_BASE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base" && argv[i + 1]) {
      base = argv[++i];
    }
  }
  return { base: base.replace(/\/$/, "") };
}

function buildUrl(base, q) {
  const params = new URLSearchParams();
  if (q.state) params.set("state", q.state);
  if (q.type) params.set("type", q.type);
  if (q.city) params.set("city", q.city);
  if (q.county) params.set("county", q.county);
  if (q.q) params.set("q", q.q);
  params.set("page", String(q.page ?? 1));
  params.set("pageSize", String(q.pageSize ?? 20));
  return `${base}/api/facilities?${params.toString()}`;
}

async function warmOne(url, timeoutMs) {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: "application/json" },
    });
    const ms = Date.now() - t0;
    let facilities = 0;
    let cache = {};
    let scoreHits = null;
    try {
      const body = await res.json();
      facilities = Array.isArray(body.facilities) ? body.facilities.length : 0;
      cache = body.meta?.cache ?? {};
      scoreHits = body.meta?.enrichment?.scoreCacheHits ?? null;
    } catch {
      /* non-json */
    }
    return {
      ok: res.ok,
      status: res.status,
      ms,
      facilities,
      cache,
      scoreHits,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - t0,
      facilities: 0,
      cache: {},
      scoreHits: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const { base } = parseArgs(process.argv.slice(2));
  const timeoutMs = Number(process.env.WARM_TIMEOUT_MS) || 180_000;
  const delayMs = Number(process.env.WARM_DELAY_MS) || 2_000;

  console.log(`Warm base: ${base}`);
  console.log(`Requests: ${QUERIES.length}  timeout=${timeoutMs}ms  delay=${delayMs}ms`);

  // Wake dyno / health first (cheap)
  try {
    const h0 = Date.now();
    const health = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(60_000),
    });
    const hBody = await health.json().catch(() => ({}));
    console.log(
      `health ${health.status} ${Date.now() - h0}ms redisOk=${hBody.redisOk ?? "?"} cacheBackend=${hBody.cacheBackend ?? "?"}`,
    );
  } catch (err) {
    console.warn(
      "health failed (continuing):",
      err instanceof Error ? err.message : err,
    );
  }

  let okCount = 0;
  const results = [];

  for (const q of QUERIES) {
    const url = buildUrl(base, q);
    const label = `${q.state ?? ""}/${q.type ?? "all"} p${q.page ?? 1}`;
    process.stdout.write(`→ ${label} … `);
    const r = await warmOne(url, timeoutMs);
    results.push({ label, url, ...r });
    if (r.ok) {
      okCount += 1;
      const cacheBits = [
        r.cache.response ? "response" : null,
        r.cache.awards ? "awards" : null,
      ]
        .filter(Boolean)
        .join("+") || "miss";
      console.log(
        `OK ${r.status} ${r.ms}ms facilities=${r.facilities} cache=${cacheBits}` +
          (r.scoreHits != null ? ` scoreHits=${r.scoreHits}` : ""),
      );
    } else {
      console.log(
        `FAIL ${r.status} ${r.ms}ms ${r.error ?? ""}`.trim(),
      );
    }
    await sleep(delayMs);
  }

  console.log(`\nDone: ${okCount}/${QUERIES.length} succeeded`);
  // Pass if at least one search warmed (partial warm still helps).
  // Fail only if everything failed (bad URL / app down).
  if (okCount === 0) {
    console.error("All warm requests failed.");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
