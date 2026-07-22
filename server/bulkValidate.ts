/**
 * Hold-out style check: does the *statistical* score elevate SAM-excluded UEIs?
 * Exclusions are NOT used as a model feature here — only as labels.
 *
 *   npm run bulk:validate
 *   npm run bulk:validate -- --state CA
 *
 * Reports top-decile lift vs chance (provable counts only).
 */
import { loadEnv } from "./env.js";
import { openBulkDuck } from "./bulkDuck.js";
import { scoreRecipient } from "./bulkScore.js";
import {
  ensureSamExclusionsIndex,
  isUeiExcluded,
} from "./samExtract.js";
import { positiveAmounts } from "./amounts.js";

loadEnv();

function parseArgs(argv: string[]) {
  let onlyState: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--state" && argv[i + 1]) onlyState = argv[++i].toUpperCase();
  }
  return { onlyState };
}

function parseCsvAmounts(csv: unknown): number[] {
  if (csv == null) return [];
  return String(csv)
    .split("|")
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log("=== Exclusion hold-out validation (statistical score only) ===\n");

  await ensureSamExclusionsIndex();
  const db = await openBulkDuck();

  const stateFilter = opts.onlyState
    ? `AND UPPER(TRIM(state_code)) = '${opts.onlyState.replace(/'/g, "''")}'`
    : "";

  const rows = await db.all<Record<string, unknown>>(`
    SELECT
      UPPER(TRIM(CAST(uei AS VARCHAR))) AS uei,
      STRING_AGG(CAST(amount AS VARCHAR), '|') AS amounts_csv
    FROM awards_grants
    WHERE uei IS NOT NULL AND TRIM(CAST(uei AS VARCHAR)) <> ''
      ${stateFilter}
    GROUP BY 1
  `);

  type Row = { uei: string; score: number; excluded: boolean; n: number };
  const scored: Row[] = [];

  for (const r of rows) {
    const uei = String(r.uei ?? "").trim().toUpperCase();
    if (!uei) continue;
    const amounts = parseCsvAmounts(r.amounts_csv);
    const n = positiveAmounts(amounts).length;
    if (n < 5) continue; // same evidence floor as bulk ranking default

    const result = scoreRecipient({
      amounts,
      fac: null, // amount-structure only (hold-out: no FAC/SAM leakage into label test)
      excluded: false, // never feed exclusion into score
    });
    if (result.fraudChance == null) continue;

    let excluded = false;
    try {
      excluded = isUeiExcluded(uei) === true;
    } catch {
      excluded = false;
    }
    scored.push({ uei, score: result.fraudChance, excluded, n });
  }

  await db.close();

  const N = scored.length;
  const excluded = scored.filter((r) => r.excluded);
  const E = excluded.length;

  console.log(`Scored recipients (n≥5 amounts, no SAM in model): ${N}`);
  console.log(`Of which on SAM public exclusion list: ${E}`);

  if (N < 50) {
    console.log("\nToo few scored rows for a meaningful report.");
    process.exit(0);
  }
  if (E < 3) {
    console.log(
      "\nFewer than 3 excluded UEIs in this set — lift estimate is unstable. Report counts only.",
    );
    console.log(
      "Excluded UEIs:",
      excluded.map((e) => e.uei).join(", ") || "(none)",
    );
    process.exit(0);
  }

  scored.sort((a, b) => b.score - a.score);
  const decileCut = Math.max(1, Math.ceil(N * 0.1));
  const topDecile = scored.slice(0, decileCut);
  const excludedInTop = topDecile.filter((r) => r.excluded).length;
  const rateTop = excludedInTop / E;
  const chance = 0.1;
  const lift = rateTop / chance;

  const meanAll = scored.reduce((s, r) => s + r.score, 0) / N;
  const meanEx = excluded.reduce((s, r) => s + r.score, 0) / E;
  const meanNon =
    scored.filter((r) => !r.excluded).reduce((s, r) => s + r.score, 0) /
    Math.max(1, N - E);

  console.log("\n--- Results (descriptive, not a court metric) ---");
  console.log(`Top decile size: ${decileCut} (${((decileCut / N) * 100).toFixed(1)}% of scored)`);
  console.log(
    `Excluded UEIs landing in top decile: ${excludedInTop} / ${E} = ${(rateTop * 100).toFixed(1)}%`,
  );
  console.log(
    `Chance baseline (10%): ${(chance * 100).toFixed(0)}%  →  lift ≈ ${lift.toFixed(2)}×`,
  );
  console.log(
    `Mean score: all=${meanAll.toFixed(1)}  excluded=${meanEx.toFixed(1)}  non-excluded=${meanNon.toFixed(1)}`,
  );
  console.log(
    "\nInterpretation: lift > 1 means statistical amount patterns alone place excluded entities above chance in the top decile. Small E → treat cautiously.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
