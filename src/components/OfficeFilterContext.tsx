import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_OFFICE, OFFICE_FILTER_OPTIONS, type OfficeFilter } from "@/lib/offices";

export { OFFICE_FILTER_OPTIONS, type OfficeFilter } from "@/lib/offices";

type Ctx = {
  office: OfficeFilter;
  setOffice: (o: OfficeFilter) => void;
  /** Returns true if a row with the given location should be shown. */
  matches: (loc: string | null | undefined) => boolean;
};

const OfficeFilterCtx = createContext<Ctx | undefined>(undefined);

export function OfficeFilterProvider({
  children,
  storageKey,
}: {
  children: ReactNode;
  /** Persist the choice per device (rep audit R-13: most reps work one
   *  office — resetting to All every visit cost a tap per open). Omit for
   *  session-only behavior. try/catch: private mode must not break the page. */
  storageKey?: string;
}) {
  const [office, setOfficeState] = useState<OfficeFilter>(() => {
    if (!storageKey) return "All";
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(storageKey) : null;
      return raw && (OFFICE_FILTER_OPTIONS as readonly string[]).includes(raw)
        ? (raw as OfficeFilter)
        : "All";
    } catch {
      return "All";
    }
  });
  const value = useMemo<Ctx>(
    () => ({
      office,
      setOffice: (o) => {
        setOfficeState(o);
        if (storageKey) {
          try {
            localStorage.setItem(storageKey, o);
          } catch {
            /* preference just won't stick */
          }
        }
      },
      matches: (loc) => office === "All" || (loc ?? DEFAULT_OFFICE) === office,
    }),
    [office, storageKey],
  );
  return <OfficeFilterCtx.Provider value={value}>{children}</OfficeFilterCtx.Provider>;
}

export function useOfficeFilter(): Ctx {
  // Allow components to render outside a provider (default to All).
  return (
    useContext(OfficeFilterCtx) ?? {
      office: "All",
      setOffice: () => {},
      matches: () => true,
    }
  );
}

export function OfficeFilterToggle({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  const { office, setOffice } = useOfficeFilter();
  // max-w-full + overflow-x-auto: a scroll container's automatic minimum
  // size is 0, so the pills can never push their row wider than the phone
  // and get clipped by the shell's overflow-x-hidden (the PR #83 trap).
  return (
    <div
      className={`inline-flex max-w-full overflow-x-auto scrollbar-hide rounded-md border border-neon/40 bg-surface p-0.5 ${className}`}
    >
      {OFFICE_FILTER_OPTIONS.map((o) => (
        <button
          key={o}
          onClick={() => setOffice(o)}
          className={`min-h-11 shrink-0 whitespace-nowrap ${compact ? "px-2 py-1" : "px-2 py-1.5 md:px-3"} text-[10px] font-display uppercase tracking-widest rounded-sm transition ${
            office === o ? "bg-neon text-background" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o === "All" ? (
            compact ? (
              "All"
            ) : (
              <>
                <span className="md:hidden">All</span>
                <span className="hidden md:inline">All Offices</span>
              </>
            )
          ) : (
            o
          )}
        </button>
      ))}
    </div>
  );
}
