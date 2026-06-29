import { useState, useCallback, useRef, useMemo } from "react";
import Papa from "papaparse";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { importHistoricalCsv } from "@/lib/csv-import.functions";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
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

// Canonical vocabulary: 'Blowout', 'CTC', 'Reset', 'Sit', 'Sale'.
const OUTCOME_TERMS: Record<string, string> = {
  blowout: "BO",
  bo: "BO",
  ctc: "BO",
  calltocancel: "BO",
  reset: "RS",
  rs: "RS",
  sit: "PM",
  pm: "PM",
  sale: "SALE",
  sold: "SALE",
};

function mapOutcome(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  const s = String(raw).trim();
  if (!s) return "";
  const term = norm(s);
  return OUTCOME_TERMS[term] ?? "";
}

const NONE = "__none__";

// Heuristic best-guess for each dropdown given the detected headers.
function guess(headers: string[], needles: string[]): string {
  for (const n of needles) {
    const target = norm(n);
    const exact = headers.find((h) => norm(h) === target);
    if (exact) return exact;
  }
  for (const n of needles) {
    const target = norm(n);
    const contains = headers.find((h) => norm(h).includes(target));
    if (contains) return contains;
  }
  return "";
}

export function HistoricalImporter({ defaultTeamId }: { defaultTeamId?: string | null }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [filename, setFilename] = useState<string | null>(null);

  // Raw parse result + mapping state
  const [rawRows, setRawRows] = useState<Record<string, unknown>[] | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapOpen, setMapOpen] = useState(false);
  const [colAgent, setColAgent] = useState<string>("");
  const [colStatus, setColStatus] = useState<string>("");
  const [colSalePrice, setColSalePrice] = useState<string>("");
  const [colDate, setColDate] = useState<string>("");

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
      resetAll();
      qc.invalidateQueries();
    },
    onError: (e: Error) => {
      toast.error("Database INSERT failed", {
        description: e.message,
        duration: 20000,
      });
    },
  });

  const resetAll = () => {
    setRawRows(null);
    setHeaders([]);
    setFilename(null);
    setMapOpen(false);
    setColAgent("");
    setColStatus("");
    setColSalePrice("");
    setColDate("");
  };

  const handleFile = useCallback((file: File) => {
    setFilename(file.name);
    Papa.parse<Record<string, unknown>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const detected = (res.meta.fields ?? []).filter((h) => h && h.trim() !== "");
        if (detected.length === 0) {
          toast.error("CSV has no readable headers");
          return;
        }
        setHeaders(detected);
        setRawRows(res.data);
        // Best-guess defaults — user can override.
        setColAgent(guess(detected, ["Agent", "Canvasser", "Rep", "Salesperson", "Name"]));
        setColStatus(guess(detected, ["Lead Status", "Status", "Outcome", "Result", "Disposition"]));
        setColSalePrice(guess(detected, ["Sale Price", "Sale Amount", "Amount", "Price"]));
        setColDate(guess(detected, ["Date/Time", "Date", "Created", "Submitted"]));
        setMapOpen(true);
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

  const mappedPreview: ParsedRow[] = useMemo(() => {
    if (!rawRows || !colAgent || !colStatus) return [];
    return rawRows
      .map((raw) => {
        const agent = String(raw[colAgent] ?? "").trim();
        const outcome = mapOutcome(raw[colStatus]);
        const date =
          colDate && colDate !== NONE ? String(raw[colDate] ?? "").trim() : "";
        const sale_price =
          colSalePrice && colSalePrice !== NONE
            ? String(raw[colSalePrice] ?? "").trim()
            : "";
        return {
          agent,
          outcome,
          date,
          sale_price: sale_price || null,
          lead_name: null,
        };
      })
      .filter((r) => r.agent && r.outcome);
  }, [rawRows, colAgent, colStatus, colSalePrice, colDate]);

  const canConfirm = !!colAgent && !!colStatus && mappedPreview.length > 0;

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
          Any CSV accepted. You'll map columns to{" "}
          <span className="text-foreground">Canvasser · Status · Sale Price</span> in the next step.
        </div>
        <div className="text-[10px] text-muted-foreground mt-1">or click to browse</div>
      </div>

      {filename && (
        <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <FileSpreadsheet className="w-4 h-4 text-neon" />
          <span className="text-foreground">{filename}</span>
          {rawRows && <span>· {rawRows.length} raw row(s) parsed</span>}
        </div>
      )}

      <Dialog open={mapOpen} onOpenChange={(o) => { if (!o) resetAll(); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-display tracking-widest text-neon">
              Map Your Columns
            </DialogTitle>
            <DialogDescription>
              Pick which column in your CSV holds each field. Rows are processed strictly from your selections.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            <FieldMap
              label="Which column holds the Canvasser Name?"
              value={colAgent}
              onChange={setColAgent}
              headers={headers}
              required
            />
            <FieldMap
              label="Which column holds the Lead Status / Outcome?"
              value={colStatus}
              onChange={setColStatus}
              headers={headers}
              required
              hint="Cells should contain: Blowout · CTC · Reset · Sit · Sale"
            />
            <FieldMap
              label="Which column holds the Sale Price?"
              value={colSalePrice}
              onChange={setColSalePrice}
              headers={headers}
              optional
            />
            <FieldMap
              label="Which column holds the Date? (optional)"
              value={colDate}
              onChange={setColDate}
              headers={headers}
              optional
            />
          </div>

          <div className="rounded border border-border bg-surface/40 px-3 py-2 text-[11px] text-muted-foreground flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-warning" />
            {mappedPreview.length > 0
              ? `Preview: ${mappedPreview.length} mappable row(s) detected with your current selections.`
              : "No mappable rows yet — pick the Canvasser and Status columns."}
          </div>

          {mappedPreview.length > 0 && (
            <div className="max-h-48 overflow-auto rounded border border-border">
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
                  {mappedPreview.slice(0, 15).map((r, i) => (
                    <tr key={i} className="border-t border-border/50">
                      <td className="px-2 py-1">{r.agent}</td>
                      <td className="px-2 py-1 text-muted-foreground">{r.date || "—"}</td>
                      <td className="px-2 py-1 uppercase text-neon">{r.outcome}</td>
                      <td className="px-2 py-1 text-right text-victory">
                        {r.sale_price
                          ? `$${Number(String(r.sale_price).replace(/[^0-9.]/g, "")).toLocaleString()}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={resetAll}>Cancel</Button>
            <Button
              disabled={!canConfirm || importMut.isPending}
              onClick={() => importMut.mutate(mappedPreview)}
              className="bg-victory text-background hover:bg-victory/90"
            >
              {importMut.isPending ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-background border-t-transparent rounded-full animate-spin" />
                  Importing…
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4" /> Confirm & Import
                </span>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ArcadePanel>
  );
}

function FieldMap({
  label,
  value,
  onChange,
  headers,
  required,
  optional,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  headers: string[];
  required?: boolean;
  optional?: boolean;
  hint?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </Label>
      <Select
        value={value || (optional ? NONE : undefined)}
        onValueChange={(v) => onChange(v === NONE ? "" : v)}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select a column…" />
        </SelectTrigger>
        <SelectContent>
          {optional && <SelectItem value={NONE}>— None —</SelectItem>}
          {headers.map((h) => (
            <SelectItem key={h} value={h}>{h}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
