import { useMemo, useState } from "react";
import { Download, X } from "lucide-react";
import { ArcadePanel, MobileCard, MobileCardHeader, MobileCardList } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ReportTable } from "@/lib/payroll-export";

/** Keep the browser honest: a 10k-row report renders its first slice; the
 *  filter (or the CSV) reaches the rest. */
const MAX_SHOWN = 500;

/**
 * On-screen report viewer (owner ask 2026-10-15: "see info without having
 * to download it"). Renders exactly the rows the CSV would contain — same
 * builders, same filters — as a desktop table with its scrollbar visible
 * (a data scroller, per the repo responsive rules) and as mobile cards.
 */
export function ReportViewer({
  title,
  table,
  onDownload,
  onClose,
}: {
  title: string;
  table: ReportTable;
  onDownload: () => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return table.rows;
    return table.rows.filter((r) => r.some((c) => c.toLowerCase().includes(q)));
  }, [table.rows, filter]);
  const shown = filtered.slice(0, MAX_SHOWN);

  // Mobile cards: the first two columns name the row (date · person in every
  // report); the rest render as label/value pairs, blanks skipped.
  const cardTitle = (r: string[]) => [r[0], r[2] || r[1]].filter(Boolean).join(" · ");

  return (
    <ArcadePanel
      title={`${title} · ${filtered.length.toLocaleString()} row${filtered.length === 1 ? "" : "s"}`}
      action={
        <span className="inline-flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={onDownload}
            className="font-display text-[10px] uppercase tracking-widest"
          >
            <Download className="w-3.5 h-3.5 mr-1" />
            CSV
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose} title="Close this report">
            <X className="w-3.5 h-3.5" />
          </Button>
        </span>
      }
    >
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter rows — name, date, status…"
          className="max-w-xs text-base md:text-sm"
        />
        {filtered.length > MAX_SHOWN && (
          <span className="text-[10px] font-display uppercase tracking-widest text-warning">
            showing first {MAX_SHOWN.toLocaleString()} — filter to narrow, or download the CSV
          </span>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="text-sm text-muted-foreground py-6 text-center">
          No rows{filter ? " match that filter" : " in this range"}.
        </div>
      ) : (
        <>
          <MobileCardList>
            {shown.map((r, i) => (
              <MobileCard key={i}>
                <MobileCardHeader left={cardTitle(r)} />
                <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                  {table.headers.map((h, c) =>
                    c < 3 || !r[c] ? null : (
                      <div key={h} className="min-w-0">
                        <div className="text-[9px] font-display uppercase tracking-widest text-muted-foreground truncate">
                          {h}
                        </div>
                        <div className="text-xs break-words">{r[c]}</div>
                      </div>
                    ),
                  )}
                </div>
              </MobileCard>
            ))}
          </MobileCardList>
          {/* Data scroller: scrollbar stays visible so desktop users can see
              there are more columns (repo rule — never scrollbar-hide here). */}
          <div className="hidden md:block overflow-x-auto max-h-[70vh] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface z-10">
                <tr className="text-[9px] font-display uppercase tracking-widest text-muted-foreground border-b border-border">
                  {table.headers.map((h) => (
                    <th key={h} className="text-left py-2 pr-3 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr
                    key={i}
                    className="border-b border-border/40 transition-colors hover:bg-surface-elevated"
                  >
                    {r.map((c, j) => (
                      <td key={j} className="py-1.5 pr-3 whitespace-nowrap tabular-nums align-top">
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </ArcadePanel>
  );
}
