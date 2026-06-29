import { useState, useCallback, useRef } from "react";
import Papa from "papaparse";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { importHistoricalCsv } from "@/lib/csv-import.functions";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Upload, FileSpreadsheet, CheckCircle2, AlertTriangle } from "lucide-react";

type ParsedRow = {
  agent: string;
  outcome: string;
  date: string;
  sale_price?: string | null;
  lead_name?: string | null;
};

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pick(row: Record<string, unknown>, ...names: string[]): string {
  const keys = Object.keys(row);
  for (const n of names) {
    const k = keys.find((kk) => norm(kk) === norm(n));
    if (k && row[k] != null && String(row[k]).trim() !== "") return String(row[k]).trim();
  }
  return "";
}

function hasAnyValue(row: Record<string, unknown>): boolean {
  return Object.values(row).some((v) => v != null && String(v).trim() !== "");
}

// Find a header that contains the substring (case/space/punctuation-insensitive).
function pickContains(row: Record<string, unknown>, substr: string): string {
  const keys = Object.keys(row);
  const s = norm(substr);
  const k = keys.find((kk) => norm(kk).includes(s));
  if (k && row[k] != null && String(row[k]).trim() !== "") return String(row[k]).trim();
  return "";
}

// Canonical vocabulary: 'Blowout', 'CTC', 'Reset', 'Sit', 'Sale'.
// Each term maps to the backend enum the importer already understands.
const OUTCOME_TERMS: Record<string, string> = {
  blowout: "BO",
  bo: "BO",
  ctc: "BO",                // "Call to cancel" rolls up as a no-demo
  calltocancel: "BO",
  reset: "RS",
  rs: "RS",
  sit: "PM",
  pm: "PM",
  sale: "SALE",
  sold: "SALE",
};

const STATUS_HEADERS = [
  "Lead Status", "Status", "Outcome", "Result", "Disposition", "Lead Outcome",
];

const SALE_PRICE_HEADERS = ["Sale Price"];

function isBlankCell(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  const s = String(v).trim();
  if (!s) return true;
  const low = s.toLowerCase();
  return low === "false" || low === "0" || low === "no" || low === "-" || low === "null" || low === "n/a";
}

function detectOutcome(row: Record<string, unknown>): string {
  const keys = Object.keys(row);
  // 1) Single status column carrying one of the canonical terms.
  for (const header of STATUS_HEADERS) {
    const k = keys.find((kk) => norm(kk) === norm(header));
    if (!k || isBlankCell(row[k])) continue;
    const term = norm(String(row[k]));
    if (OUTCOME_TERMS[term]) return OUTCOME_TERMS[term];
  }
  // 2) Boolean-style columns named after the canonical terms.
  //    Sale > Sit > Reset > CTC > Blowout priority.
  for (const col of ["Sale", "Sit", "Reset", "CTC", "Blowout"]) {
    const target = norm(col);
    const k = keys.find((kk) => norm(kk) === target);
    if (!k || isBlankCell(row[k])) continue;
    return OUTCOME_TERMS[norm(col)];
  }
  return "";
}


export function HistoricalImporter({ defaultTeamId }: { defaultTeamId?: string | null }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<ParsedRow[] | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const importFn = useServerFn(importHistoricalCsv);

  const importMut = useMutation({
    mutationFn: async (rows: ParsedRow[]) =>
      importFn({ data: { rows, team_id: defaultTeamId ?? null } }),
    onSuccess: (res) => {
      if (res.updated_logs === 0) {
        toast.error("Import wrote 0 rows to the database", {
          description: `Parsed ${res.parsed_rows ?? 0} rows but nothing was saved. ${res.errors?.[0]?.reason ?? "No row-level errors reported."}`,
          duration: 15000,
        });
      } else {
        toast.success("Database write complete", {
          description: `+${res.created_profiles} canvassers · ${res.updated_logs} daily_logs rows · ${res.inserted_sales} sales`,
        });
      }
      if (res.errors?.length) {
        for (const e of res.errors.slice(0, 5)) {
          toast.error(`Row ${e.row}: ${e.reason}`, { duration: 12000 });
        }
      }
      setPreview(null);
      setFilename(null);
      qc.invalidateQueries();
    },
    onError: (e: Error) => {
      toast.error("Database INSERT failed", {
        description: e.message,
        duration: 20000,
      });
    },
  });


  const handleFile = useCallback((file: File) => {
    setFilename(file.name);
    setPreview(null);
    Papa.parse<Record<string, unknown>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const rows: ParsedRow[] = res.data
          .filter(hasAnyValue)
          .map((raw) => {
            const agent = pick(raw, "Agent");
            const date = pick(raw, "Date/Time") || pickContains(raw, "date");
            const sale_price = pick(raw, ...SALE_PRICE_HEADERS);
            const lead_name = pick(raw, "Lead", "Customer", "Lead Name", "Customer Name");
            const outcome = detectOutcome(raw);
            return { agent, outcome, date, sale_price: sale_price || null, lead_name: lead_name || null };
          })
          // Skip blank-agent rows and rows with no detected outcome — no error toast, just ignore.
          .filter((r) => r.agent && r.outcome);
        setPreview(rows);

      },
      error: (err) => toast.error(`CSV parse failed: ${err.message}`),
    });
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  return (
    <ArcadePanel title="Historical Data Importer">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`relative cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
          dragOver
            ? "border-neon bg-[color-mix(in_oklab,var(--neon)_8%,var(--surface))]"
            : "border-border bg-surface hover:border-neon/60"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
        <Upload className="w-8 h-8 mx-auto text-neon mb-3" />
        <div className="font-display text-sm text-neon">DROP MONDAY.COM CSV HERE</div>
        <div className="text-xs text-muted-foreground mt-2">
          Any CSV accepted. Uses <span className="text-foreground">Agent · Date · Sale Price</span>, then detects{" "}
          <span className="text-foreground">Blowout · CTC · Reset · Sit · Sale</span>.

        </div>
        <div className="text-[10px] text-muted-foreground mt-1">or click to browse</div>
      </div>

      <Button
        size="lg"
        disabled={!preview || importMut.isPending}
        onClick={() => preview && importMut.mutate(preview)}
        className={`mt-4 w-full font-display tracking-widest text-base h-14 transition-all ${
          preview && !importMut.isPending
            ? "bg-neon text-background hover:bg-neon/90 shadow-[0_0_20px_var(--neon),0_0_40px_var(--neon)] animate-pulse"
            : "bg-surface text-muted-foreground border border-border cursor-not-allowed"
        }`}
      >
        {importMut.isPending ? (
          <span className="flex items-center gap-2">
            <span className="w-4 h-4 border-2 border-background border-t-transparent rounded-full animate-spin" />
            PROCESSING…
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5" /> PROCESS CSV
          </span>
        )}
      </Button>

      {filename && (
        <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <FileSpreadsheet className="w-4 h-4 text-neon" />
          <span className="text-foreground">{filename}</span>
          {preview && <span>· accepted · {preview.length} row(s) scanned</span>}
        </div>
      )}

      {preview && (
        <>
          <div className="mt-4 max-h-56 overflow-auto rounded border border-border">
            <table className="w-full text-xs">
              <thead className="bg-surface sticky top-0">
                <tr className="text-left text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  <th className="px-2 py-1.5">Agent</th>
                  <th className="px-2 py-1.5">Date</th>
                  <th className="px-2 py-1.5">Outcome</th>
                  <th className="px-2 py-1.5 text-right">Sale $</th>
                </tr>
              </thead>
              <tbody>
                {preview.slice(0, 25).map((r, i) => (
                  <tr key={i} className="border-t border-border/50">
                    <td className="px-2 py-1">{r.agent}</td>
                    <td className="px-2 py-1 text-muted-foreground">{r.date}</td>
                    <td className="px-2 py-1 uppercase text-neon">{r.outcome}</td>
                    <td className="px-2 py-1 text-right text-victory">
                      {r.sale_price ? `$${Number(String(r.sale_price).replace(/[^0-9.]/g, "")).toLocaleString()}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.length > 25 && (
              <div className="text-[10px] text-muted-foreground p-2 border-t border-border">
                + {preview.length - 25} more rows…
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-[11px] text-muted-foreground flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-warning" />
              Unknown agents will be auto-created as Canvassers.
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => { setPreview(null); setFilename(null); }}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={importMut.isPending}
                onClick={() => importMut.mutate(preview)}
                className="bg-victory text-background hover:bg-victory/90"
              >
                {importMut.isPending ? "Running Paycheck Engine…" : (
                  <span className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> Run Import</span>
                )}
              </Button>
            </div>
          </div>
        </>
      )}
    </ArcadePanel>
  );
}
