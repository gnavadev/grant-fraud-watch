/** Lightweight SVG charts — no chart library needed. */

export function HorizontalBars({
  items,
  max = 100,
}: {
  items: { label: string; value: number; hint?: string; color?: string }[];
  max?: number;
}) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-stone-500">No data for this chart yet.</p>
    );
  }

  return (
    <div className="space-y-2.5">
      {items.map((item) => {
        const pct = Math.min(100, Math.max(0, (item.value / max) * 100));
        const color = item.color ?? barColor(item.value);
        return (
          <div key={item.label} title={item.hint}>
            <div className="mb-0.5 flex items-baseline justify-between gap-2 text-xs">
              <span className="font-medium text-stone-700">{item.label}</span>
              <span className="tabular-nums text-stone-500">
                {Math.round(item.value)}
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-stone-100">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${pct}%`, backgroundColor: color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function barColor(v: number): string {
  if (v >= 67) return "#b91c1c";
  if (v >= 34) return "#d97706";
  return "#059669";
}

/** Simple bar chart for leading digits 1–9 */
export function DigitBars({
  observed,
  expected,
}: {
  observed: Record<string, number>;
  expected: number[];
}) {
  const total = Object.values(observed).reduce((a, b) => a + b, 0);
  if (total === 0) {
    return (
      <p className="text-sm text-stone-500">
        Not enough amount samples to show digit patterns.
      </p>
    );
  }

  const maxPct = Math.max(
    ...expected,
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (observed[String(d)] ?? 0) / total),
    0.01,
  );

  const w = 280;
  const h = 140;
  const pad = { t: 10, b: 24, l: 28, r: 8 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const groupW = innerW / 9;

  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full max-w-md" role="img">
        <title>Leading digits: actual vs typical pattern</title>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d, i) => {
          const obs = (observed[String(d)] ?? 0) / total;
          const exp = expected[i] ?? 0;
          const x = pad.l + i * groupW;
          const barW = groupW * 0.35;
          const oh = (obs / maxPct) * innerH;
          const eh = (exp / maxPct) * innerH;
          return (
            <g key={d}>
              <rect
                x={x + groupW * 0.1}
                y={pad.t + innerH - eh}
                width={barW}
                height={eh}
                fill="#fdba74"
                rx={2}
              />
              <rect
                x={x + groupW * 0.5}
                y={pad.t + innerH - oh}
                width={barW}
                height={oh}
                fill="#c2410c"
                rx={2}
              />
              <text
                x={x + groupW * 0.45}
                y={h - 6}
                textAnchor="middle"
                className="fill-stone-500"
                fontSize="10"
              >
                {d}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex flex-wrap gap-4 text-xs text-stone-600">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-orange-300" />
          Typical pattern
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-orange-700" />
          This facility
        </span>
      </div>
    </div>
  );
}

/** Min / average / max award sizes as easy bars */
export function SizeSummaryBars({
  min,
  avg,
  max,
}: {
  min: number;
  avg: number;
  max: number;
}) {
  if (max <= 0) {
    return <p className="text-sm text-stone-500">No award size data.</p>;
  }
  const items = [
    { label: "Smallest amount", value: min },
    { label: "Average amount", value: avg },
    { label: "Largest amount", value: max },
  ];
  return (
    <div className="space-y-2.5">
      {items.map((item) => {
        const pct = (item.value / max) * 100;
        return (
          <div key={item.label}>
            <div className="mb-0.5 flex justify-between text-xs">
              <span className="font-medium text-stone-700">{item.label}</span>
              <span className="tabular-nums text-stone-600">
                {formatMoney(item.value)}
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-stone-100">
              <div
                className="h-full rounded-full bg-orange-600"
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

/** Expected Benford proportions for digits 1–9 */
export const BENFORD_EXPECTED = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(
  (d) => Math.log10(1 + 1 / d),
);
