import type { Request, Response, NextFunction } from "express";

/**
 * Simple in-memory sliding window rate limiter (per IP).
 * Good enough for free-tier single instance; not for multi-node clusters.
 */
export function rateLimit(options: {
  windowMs: number;
  max: number;
  /** Only apply when predicate is true (default: always). */
  when?: (req: Request) => boolean;
}): (req: Request, res: Response, next: NextFunction) => void {
  const hits = new Map<string, number[]>();
  const { windowMs, max, when } = options;

  // Periodic cleanup
  setInterval(() => {
    const now = Date.now();
    for (const [ip, times] of hits) {
      const kept = times.filter((t) => now - t < windowMs);
      if (kept.length === 0) hits.delete(ip);
      else hits.set(ip, kept);
    }
  }, Math.min(windowMs, 60_000)).unref?.();

  return (req, res, next) => {
    if (when && !when(req)) {
      next();
      return;
    }
    const ip =
      (typeof req.headers["x-forwarded-for"] === "string"
        ? req.headers["x-forwarded-for"].split(",")[0]?.trim()
        : null) ||
      req.socket.remoteAddress ||
      "unknown";

    const now = Date.now();
    const prev = hits.get(ip) ?? [];
    const recent = prev.filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      res.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
      res.status(429).json({
        error:
          "Too many searches from this address. Please wait a minute and try again.",
      });
      return;
    }
    recent.push(now);
    hits.set(ip, recent);
    next();
  };
}
