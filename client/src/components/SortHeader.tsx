import type { SortKey, SortSpec } from "../types";

interface Props {
  label: string;
  sortKey: SortKey;
  sorts: SortSpec[];
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
  hint?: string;
}

export function SortHeader({
  label,
  sortKey,
  sorts,
  onSort,
  align = "left",
  hint,
}: Props) {
  const idx = sorts.findIndex((s) => s.key === sortKey);
  const active = idx >= 0 ? sorts[idx] : null;
  const priority = idx >= 0 ? idx + 1 : null;

  const arrow = !active ? "↕" : active.dir === "asc" ? "↑" : "↓";

  return (
    <th
      scope="col"
      className={`px-4 py-3 text-xs font-semibold uppercase tracking-wide text-stone-500 ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={
          hint ??
          "Click to sort. First click: A to Z or low to high. Second: reverse. Third: clear."
        }
        className={`group inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 transition hover:bg-orange-50 hover:text-stone-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
          align === "right" ? "flex-row-reverse" : ""
        } ${active ? "text-orange-800" : ""}`}
      >
        <span>{label}</span>
        <span
          className={`inline-flex h-5 min-w-5 items-center justify-center rounded text-[11px] ${
            active
              ? "bg-orange-100 font-bold text-orange-800"
              : "text-stone-400 group-hover:text-stone-600"
          }`}
          aria-hidden
        >
          {arrow}
          {priority != null && sorts.length > 1 ? (
            <sup className="ml-0.5 text-[9px]">{priority}</sup>
          ) : null}
        </span>
      </button>
    </th>
  );
}
