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

function pickContains(row: Record<string, unknown>, substr: string): string {
  const keys = Object.keys(row);
  const s = norm(substr);
  const k = keys.find((kk) => norm(kk).includes(s));
  if (k && row[k] != null && String(row[k]).trim() !== "") return String(row[k]).trim();
  return "";
}

function hasAnyValue(row: Record<string, unknown>): boolean {
  return Object.values(row).some((v) => v != null && String(v).trim() !== "");
}

// Cells we treat as "unmarked". Anything else (✓, x, 1, "yes", a date, any text)
// counts as the column being marked for that row.
function isMarked(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  if (!s) return false;
  const low = s.toLowerCase();
  if (low === "false" || low === "0" || low === "no" || low === "-" ||
      low === "null" || low === "n/a" || low === "na") return false;
  return true;
}

// The five canonical outcome columns from Monday.com.
// Maps the column header → backend outcome enum the importer understands.
// Per spec: BO=Blowout(0pt) · OL=Sit/PitchMiss(1pt) · Sale=2pt · CTC=Cancel(0pt) · Reset(0pt)
// OL is intentionally mapped to "PM" so the Paycheck Engine credits it as a 1pt sit.
const OUTCOME_COLUMNS: { header: string; outcome: string }[] = [
  { header: "Sale",  outcome: "SALE" },
  { header: "OL",    outcome: "PM"   },
  { header: "CTC",   outcome: "BO"   },
  { header: "Reset", outcome: "RS"   },
  { header: "BO",    outcome: "BO"   },
];

// Returns the canonical outcome based on which of the 5 columns has a mark.
// Priority: Sale > OL > CTC > Reset > BO.
function detectOutcomeFromColumns(row: Record<string, unknown>): string {
  const keys = Object.keys(row);
  for (const { header, outcome } of OUTCOME_COLUMNS) {
    const k = keys.find((kk) => norm(kk) === norm(header));
    if (k && isMarked(row[k])) return outcome;
  }
  return "";
}

const SALE_PRICE_HEADERS = ["Sale Price", "Sale Amount", "Amount"];

export function HistoricalImporter({ defaultTeamId }: { defaultTeamId?: string | null }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<ParsedRow[] | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [missingColumns, setMissingColumns] = useState<string[]>([]);
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
      setMissingColumns([]);
      qc.invalidateQueries();
    },
    onError: (e: Error) => {
      toast.error("Database INSERT failed", { description: e.message, duration: 20000 });
    },
  });

  const handleFile = useCallback((file: File) => {
    setFilename(file.name);
    setPreview(null);
    setMissingColumns([]);
    Papa.parse<Record<string, unknown>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const headers = (res.meta.fields ?? []).map((h) => h ?? "");
        const headerNorm = headers.map(norm);
        const missing = OUTCOME_COLUMNS
          .map((c) => c.header)
          .filter((h) => !headerNorm.includes(norm(h)));
        setMissingColumns(missing);

        const rows: ParsedRow[] = res.data
          .filter(hasAnyValue)
          .map((raw) => {
            const agent = pick(raw, "Agent", "Canvasser", "Rep", "Salesperson");
            const date = pick(raw, "Date/Time") || pickContains(raw, "date");
            const sale_price = pick(raw, ...SALE_PRICE_HEADERS);
            const lead_name = pick(raw, "Lead", "Customer", "Lead Name", "Customer Name");
            const outcome = detectOutcomeFromColumns(raw);
            return { agent, outcome, date, sale_price: sale_price || null, lead_name: lead_name || null };
          })
          .filter((r) => r.agent && r.outcome);

        setPreview(rows);
        if (rows.length === 0) {
          toast.error("Parsed 0 rows", {
            description: missing.length
              ? `Missing outcome columns: ${missing.join(", ")}. Expected headers: BO, OL, Sale, CTC, Reset.`
              : "No rows had a mark in BO / OL / Sale / CTC / Reset.",
            duration: 15000,
          });
        }
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

  const counts = preview
    ? preview.reduce<Record<string, number>>((acc, r) => {
        acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
        return acc;
      }, {})
    : {};

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
          Reads <span className="text-foreground">Agent</span>, <span className="text-foreground">Sale Price</span>,
          and the 5 outcome columns:{" "}
          <span className="text-foreground">BO · OL · Sale · CTC · Reset</span>.
        </div>
        <div className="text-[10px] text-muted-foreground mt-1">or click to browse</div>
      </div>

      {filename && (
        <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <FileSpreadsheet className="w-4 h-4 text-neon" />
          <span className="text-foreground">{filename}</span>
          {preview && <span>· {preview.length} row(s) with a marked outcome</span>}
        </div>
      )}

      {missingColumns.length > 0 && (
        <div className="mt-3 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Missing outcome column header(s):{" "}
            <span className="font-semibold">{missingColumns.join(", ")}</span>. Rows under those buckets won't be counted.
          </span>
        </div>
      )}

      {preview && preview.length > 0 && (
        <>
          <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
            {[
              { k: "SALE", label: "Sale" },
              { k: "PM",   label: "OL / Sit" },
              { k: "BO",   label: "BO + CTC" },
              { k: "RS",   label: "Reset" },
            ].map(({ k, label }) => (
              <span key={k} className="rounded border border-border bg-surface px-2 py-1 font-display tracking-wider text-muted-foreground">
                {label}: <span className="text-foreground">{counts[k] ?? 0}</span>
              </span>
            ))}
          </div>

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
                    <td className="px-2 py-1 text-muted-foreground">{r.date || "—"}</td>
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
              Unknown agents will be auto-created as Canvassers. Existing weekly buckets will be refreshed.
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => { setPreview(null); setFilename(null); setMissingColumns([]); }}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={importMut.isPending}
                onClick={() => importMut.mutate(preview)}
                className="bg-victory text-background hover:bg-victory/90"
              >
                {importMut.isPending ? "Running Paycheck Engine…" : (
                  <span className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> Confirm & Import</span>
                )}
              </Button>
            </div>
          </div>
        </>
      )}
    </ArcadePanel>
  );
}
