/**
 * Lightweight structured logging. Never log secrets / API keys.
 */

const SECRET_PATTERNS = [
  /api[_-]?key[=:]\s*["']?[\w-]+/gi,
  /SAM-[0-9a-f-]{20,}/gi,
  /Bearer\s+\S+/gi,
  /(FAC_API_KEY|SAM_API_KEY|DATA_GOV_API_KEY)=[^\s&]+/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

function safeMsg(err: unknown): string {
  if (err instanceof Error) return redact(err.message);
  return redact(String(err));
}

type Level = "info" | "warn" | "error";

function emit(level: Level, event: string, fields?: Record<string, unknown>) {
  const row: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
  };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      if (typeof v === "string") row[k] = redact(v);
      else if (v instanceof Error) row[k] = safeMsg(v);
      else row[k] = v;
    }
  }
  const line = JSON.stringify(row);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields?: Record<string, unknown>) =>
    emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) =>
    emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) =>
    emit("error", event, fields),
};
