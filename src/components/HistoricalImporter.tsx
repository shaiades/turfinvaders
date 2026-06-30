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
  van?: string | null;
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

// Canonical outcome columns from Monday.com → backend outcome enum.
// POINT VALUES (locked by spec):
//   Sale = 2 pts   PM = 1 pt   BO/CTC/RS/OL = 0 pts
// PRIORITY when multiple columns are marked on the same row:
//   Sale > PM > RS > BO > CTC > OL
const OUTCOME_TOKENS: { token: string; outcome: string }[] = [
  { token: "sale",  outcome: "SALE" },
  { token: "pm",    outcome: "PM"   },
  { token: "reset", outcome: "RS"   },
  { token: "bo",    outcome: "BO"   },
  { token: "ctc",   outcome: "BO"   }, // CTC routes into the BO (no-demo) bucket, still 0 pts
  { token: "ol",    outcome: "OL"   },
];


const SALE_PRICE_HEADERS = ["Sale Price", "Sale Amount", "Amount"];
const AGENT_HEADERS = ["Agent", "Canvasser", "Rep", "Salesperson"];
const LEAD_HEADERS = ["Lead", "Customer", "Lead Name", "Customer Name"];
const VAN_HEADERS = ["Van", "Team", "Crew", "Faction"];

// Resolve which raw CSV header maps to each of the 5 outcome buckets.
// Strategy: prefer exact normalized equality; fall back to substring match,
// skipping headers already claimed by Agent / Date / Sale Price / Lead Name.
function resolveOutcomeHeaders(
  headers: string[],
  claimed: Set<string>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const used = new Set<string>();
  for (const { token, outcome } of OUTCOME_TOKENS) {
    if (out[outcome]) continue;
    const hit = headers.find(
      (h) => !claimed.has(h) && !used.has(h) && norm(h) === token,
    );
    if (hit) { out[outcome] = hit; used.add(hit); }
  }
  for (const { token, outcome } of OUTCOME_TOKENS) {
    if (out[outcome]) continue;
    const hit = headers.find(
      (h) => !claimed.has(h) && !used.has(h) && norm(h).includes(token),
    );
    if (hit) { out[outcome] = hit; used.add(hit); }
  }
  for (const { outcome } of OUTCOME_TOKENS) {
    if (!(outcome in out)) out[outcome] = null;
  }
  return out;
}

function pickHeader(headers: string[], ...names: string[]): string | null {
  for (const n of names) {
    const exact = headers.find((h) => norm(h) === norm(n));
    if (exact) return exact;
  }
  for (const n of names) {
    const contains = headers.find((h) => norm(h).includes(norm(n)));
    if (contains) return contains;
  }
  return null;
}

function pickDateHeader(headers: string[]): string | null {
  return (
    headers.find((h) => norm(h) === "datetime") ??
    headers.find((h) => norm(h) === "date") ??
    headers.find((h) => norm(h).includes("date")) ??
    null
  );
}

export function HistoricalImporter({
  defaultTeamId,
  onImported,
}: {
  defaultTeamId?: string | null;
  onImported?: () => void;
}) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<ParsedRow[] | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [missingColumns, setMissingColumns] = useState<string[]>([]);
  const importFn = useServerFn(importHistoricalCsv);

  const importMut = useMutation({
    mutationFn: async (rows: ParsedRow[]) => {
      try {
        const res = await importFn({ data: { rows, team_id: defaultTeamId ?? null } });
        return res;
      } catch (err: unknown) {
        // Normalize server errors so onError always sees an Error w/ message.
        const msg =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : (() => {
                  try { return JSON.stringify(err); } catch { return "Unknown server error"; }
                })();
        throw new Error(msg);
      }
    },
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
        // Auto-close the import modal/panel only on a real write.
        setPreview(null);
        setFilename(null);
        setMissingColumns([]);
        onImported?.();
      }
      if (res.errors?.length) {
        for (const e of res.errors.slice(0, 5)) {
          toast.error(`Row ${e.row}: ${e.reason}`, { duration: 12000 });
        }
      }
      // Always refresh downstream queries (Payroll Ledger, Performance Matrix, etc.)
      qc.invalidateQueries();
    },
    onError: (e: Error) => {
      toast.error("Database INSERT failed — see details", {
        description: e?.message ?? "Unknown error (no message returned from server).",
        duration: 20000,
      });
    },
    // Belt & suspenders: react-query already flips isPending off on success/error,
    // but onSettled guarantees the button text resets even if a handler throws.
    onSettled: () => {
      // No-op state writes here force a re-render so `importMut.isPending`
      // is read fresh by the button. Keeps the UI from appearing stuck.
      setDragOver((d) => d);
    },
  });

  const handleFile = useCallback((file: File) => {
    setFilename(file.name);
    setPreview(null);
    setMissingColumns([]);

    // Monday.com exports prepend title/metadata rows ("This spreadsheet was
    // created using monday.com", blank rows, etc.) before the real header.
    // Read raw text, scan the first 10 rows for one that contains "Agent"
    // or "Sale Price" (case-insensitive, trimmed), then slice from there.
    const reader = new FileReader();
    reader.onerror = () => toast.error("Could not read file");
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const scan = Papa.parse<string[]>(text, {
        header: false,
        skipEmptyLines: false,
        preview: 10,
      });
      const scanRows = (scan.data ?? []) as string[][];
      let headerIdx = -1;
      for (let i = 0; i < scanRows.length; i++) {
        const cells = (scanRows[i] ?? []).map((c) => String(c ?? "").toLowerCase().trim());
        if (cells.some((c) => c === "agent" || c === "sale price" || c.includes("agent") || c.includes("sale price"))) {
          headerIdx = i;
          break;
        }
      }
      if (headerIdx === -1) {
        toast.error("Could not locate header row", {
          description: "Scanned the first 10 rows for 'Agent' or 'Sale Price' and found neither.",
          duration: 15000,
        });
        return;
      }

      const lines = text.split(/\r?\n/);
      const sliced = lines.slice(headerIdx).join("\n");

      Papa.parse<Record<string, unknown>>(sliced, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => (h ?? "").toString().trim(),
        complete: (res) => {
          const headers = (res.meta.fields ?? []).map((h) => (h ?? "").toString());

          const agentHeader = pickHeader(headers, ...AGENT_HEADERS);
          const dateHeader = pickDateHeader(headers);
          const salePriceHeader = pickHeader(headers, ...SALE_PRICE_HEADERS);
          const leadHeader = pickHeader(headers, ...LEAD_HEADERS);
          const vanHeader = pickHeader(headers, ...VAN_HEADERS);

          const claimed = new Set<string>(
            [agentHeader, dateHeader, salePriceHeader, leadHeader, vanHeader].filter(
              (x): x is string => !!x,
            ),
          );
          const outcomeMap = resolveOutcomeHeaders(headers, claimed);
          const missing = OUTCOME_TOKENS
            .filter(({ outcome }) => !outcomeMap[outcome])
            .map(({ token }) => token.toUpperCase());
          setMissingColumns(missing);

          const rows: ParsedRow[] = res.data
            .filter(hasAnyValue)
            .map((raw) => {
              const agent = agentHeader ? String(raw[agentHeader] ?? "").trim() : "";
              const date = dateHeader ? String(raw[dateHeader] ?? "").trim() : "";
              const sale_price = salePriceHeader ? String(raw[salePriceHeader] ?? "").trim() : "";
              const lead_name = leadHeader ? String(raw[leadHeader] ?? "").trim() : "";
              const van = vanHeader ? String(raw[vanHeader] ?? "").trim() : "";
              // Walk OUTCOME_TOKENS in priority order; first marked column wins.
              let outcome = "";
              for (const { outcome: o } of OUTCOME_TOKENS) {
                const h = outcomeMap[o];
                if (h && isMarked(raw[h])) { outcome = o; break; }
              }
              return { agent, outcome, date, sale_price: sale_price || null, lead_name: lead_name || null, van: van || null };
            })
            .filter((r) => r.agent && r.outcome);

          setPreview(rows);
          if (rows.length === 0) {
            toast.error("Parsed 0 rows", {
              description: missing.length
                ? `Could not detect outcome columns: ${missing.join(", ")}. Headers seen (row ${headerIdx + 1}): ${headers.join(", ") || "none"}.`
                : `Detected outcome columns but no row had a mark. Header row: ${headerIdx + 1}.`,
              duration: 15000,
            });
          } else if (headerIdx > 0) {
            toast.success(`Skipped ${headerIdx} metadata row(s) — header on row ${headerIdx + 1}`);
          }
        },
        error: (err: { message: string }) => toast.error(`CSV parse failed: ${err.message}`),
      });
    };
    reader.readAsText(file);
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
              { k: "SALE", label: "Sale (2pt)" },
              { k: "OL",   label: "OL · One Leg (0pt)" },
              { k: "BO",   label: "BO + CTC (0pt)" },
              { k: "RS",   label: "Reset (0pt)" },
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
