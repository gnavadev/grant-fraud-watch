/**
 * List USAspending Award Data Archive keys for the configured FY window.
 *   npm run bulk:list-usa
 */
import {
  loadConfig,
  listS3Keys,
  usaAssistanceUrl,
} from "./lib.mjs";

const cfg = loadConfig();
const fys = [];
for (let y = cfg.fyStart; y <= cfg.fyEnd; y++) fys.push(y);

console.log(`FY window ${cfg.fyStart}–${cfg.fyEnd}`);
console.log("Configured All-agency URLs:");
for (const fy of fys) {
  console.log(`  ${usaAssistanceUrl(cfg, fy, "All")}`);
}

console.log("\nS3 listing (All_Assistance Full zips):");
for (const fy of fys) {
  const keys = await listS3Keys(`FY${fy}_All_Assistance_Full_`, 20);
  if (keys.length === 0) {
    console.log(`  FY${fy}: (none found for date tag — listing any All_Assistance)`);
    const any = await listS3Keys(`FY${fy}_All_Assistance`, 10);
    for (const k of any) console.log(`    ${k}`);
  } else {
    for (const k of keys) console.log(`  ${k}`);
  }
}

console.log("\nProbe agency 025 (small):");
for (const fy of [2024]) {
  const keys = await listS3Keys(`FY${fy}_025_Assistance`, 5);
  for (const k of keys) console.log(`  ${k}`);
}
