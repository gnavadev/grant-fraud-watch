interface Props {
  variant: "welcome" | "error";
  message?: string;
  onRetry?: () => void;
}

export function EmptyState({ variant, message, onRetry }: Props) {
  if (variant === "error") {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50/90 px-6 py-12 text-center shadow-sm">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-red-700">
          !
        </div>
        <h3 className="text-lg font-semibold text-red-900">
          We could not load that search
        </h3>
        <p className="mx-auto mt-2 max-w-md text-sm text-red-800/90">
          {message ?? "Please try again in a moment."}
        </p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-5 rounded-lg bg-orange-700 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-800"
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-dashed border-stone-300 bg-white/80 px-6 py-14 text-center shadow-sm">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-orange-100 text-2xl">
        🔍
      </div>
      <h3 className="text-lg font-semibold text-stone-900">
        Search federal grant recipients
      </h3>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-stone-600">
        Pick a <strong>state</strong> and/or a <strong>facility type</strong>{" "}
        (like Daycare or Healthcare), then press <strong>Search</strong>.
      </p>
    </div>
  );
}
