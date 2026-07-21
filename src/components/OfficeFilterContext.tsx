import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export const OFFICE_FILTER_OPTIONS = ["All", "San Diego", "Orange County"] as const;
export type OfficeFilter = (typeof OFFICE_FILTER_OPTIONS)[number];

type Ctx = {
  office: OfficeFilter;
  setOffice: (o: OfficeFilter) => void;
  /** Returns true if a row with the given location should be shown. */
  matches: (loc: string | null | undefined) => boolean;
};

const OfficeFilterCtx = createContext<Ctx | undefined>(undefined);

export function OfficeFilterProvider({ children }: { children: ReactNode }) {
  const [office, setOffice] = useState<OfficeFilter>("All");
  const value = useMemo<Ctx>(
    () => ({
      office,
      setOffice,
      matches: (loc) => office === "All" || (loc ?? "San Diego") === office,
    }),
    [office],
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
  return (
    <div className={`inline-flex rounded-md border border-neon/40 bg-surface p-0.5 ${className}`}>
      {OFFICE_FILTER_OPTIONS.map((o) => (
        <button
          key={o}
          onClick={() => setOffice(o)}
          className={`min-h-9 ${compact ? "px-2 py-1" : "px-3 py-1.5"} text-[10px] font-display uppercase tracking-widest rounded-sm transition ${
            office === o ? "bg-neon text-background" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o === "All" ? (compact ? "All" : "All Offices") : o}
        </button>
      ))}
    </div>
  );
}
