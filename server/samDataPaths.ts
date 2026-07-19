import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Project root (works for tsx server/ and compiled dist/). */
export function projectRoot(): string {
  // dist/index.js → .. ; server/foo.ts → ..
  return path.resolve(__dirname, "..");
}

/** Bundled slim data committed to the repo (or baked into Docker). */
export function dataSamDir(): string {
  return path.join(projectRoot(), "data", "sam");
}

export function bundledExclusionsPath(): string {
  return path.join(dataSamDir(), "exclusions_ueis.txt");
}

export function bundledEntityDbPath(): string {
  return path.join(dataSamDir(), "entities.sqlite");
}

/** Runtime cache (downloads, rebuilds). Ephemeral on free hosts. */
export function cacheSamDir(): string {
  return path.join(projectRoot(), ".cache", "sam");
}

export function cacheExclusionsJsonPath(): string {
  return path.join(cacheSamDir(), "exclusions_ueis.json");
}

export function cacheEntityDbPath(): string {
  return path.join(cacheSamDir(), "entities.sqlite");
}
