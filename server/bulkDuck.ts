/**
 * Open the local bulk DuckDB (awards + FAC) built by npm run bulk:load.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export function bulkDuckPath(): string {
  return (
    process.env.BULK_DUCKDB_PATH?.trim() ||
    path.join(ROOT, "data", "bulk", "duckdb", "gfw.duckdb")
  );
}

export function bulkDuckExists(): boolean {
  return fs.existsSync(bulkDuckPath());
}

export type DuckConn = {
  all: <T = Record<string, unknown>>(sql: string) => Promise<T[]>;
  run: (sql: string) => Promise<void>;
  close: () => Promise<void>;
};

export async function openBulkDuck(
  filePath = bulkDuckPath(),
): Promise<DuckConn> {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `DuckDB not found at ${filePath}. Run: npm run bulk:load`,
    );
  }
  const mod = await import("duckdb");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const DatabaseCtor = (mod as any).Database ?? (mod as any).default?.Database;
  if (typeof DatabaseCtor !== "function") {
    throw new Error("duckdb.Database not available (npm i duckdb)");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = await new Promise((resolve, reject) => {
    const d = new DatabaseCtor(filePath, (err: Error | null) =>
      err ? reject(err) : resolve(d),
    );
  });

  const d = db;

  return {
    all: <T = Record<string, unknown>>(sql: string) =>
      new Promise<T[]>((resolve, reject) => {
        d.all(sql, (err: Error | null, rows: T[]) =>
          err ? reject(err) : resolve(rows ?? []),
        );
      }),
    run: (sql: string) =>
      new Promise<void>((resolve, reject) => {
        d.run(sql, (err: Error | null) => (err ? reject(err) : resolve()));
      }),
    close: () =>
      new Promise<void>((resolve) => {
        d.close(() => resolve());
      }),
  };
}
