import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarOff, Download, FileClock, FileSpreadsheet, ScrollText } from "lucide-react";
import { ArcadeCard } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PayrollLedger } from "@/components/PayrollLedger";
import { downloadCsvFile } from "@/lib/csv";
import {
  buildAbsenceCsvLines,
  buildAuditCsvLines,
  buildPayrollRangeCsvLines,
  buildPunchDetailCsvLines,
  weekStartsInRange,
} from "@/lib/payroll-export";
import { addDaysISO, laMonthStartISO, laTodayISO, laWeekStartISO, weekStartOfISO } from "@/lib/dates";

export type ReportsTab = "exports" | "payroll";

const FIELD_LABEL = "text-[10px] font-display uppercase tracking-widest text-muted-foreground";

function RangeInputs({
  from,
  to,
  setFrom,
  setTo,
}: {
  from: string;
  to: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <label className="block space-y-1">
        <span className={FIELD_LABEL}>From</span>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="text-base md:text-sm" />
      </label>
      <label className="block space-y-1">
        <span className={FIELD_LABEL}>To</span>
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="text-base md:text-sm" />
      </label>
    </div>
  );
}

/**
 * The accountant's console (Mary + the Admin tier): every export the books
 * or a wage matter could need, date-ranged, plus the read-only payroll
 * ledger. All times Pacific; all cells formula-injection-guarded.
 */
export function ReportsConsole({
  tab,
  onTabChange,
}: {
  tab: ReportsTab;
  onTabChange: (t: ReportsTab) => void;
}) {
  const today = laTodayISO();
  // Payroll: default to the last 4 completed weeks.
  const [payrollFrom, setPayrollFrom] = useState(() => addDaysISO(laWeekStartISO(), -28));
  const [payrollTo, setPayrollTo] = useState(() => addDaysISO(laWeekStartISO(), -7));
  // Punch detail + audit: default to this month so far.
  const [punchFrom, setPunchFrom] = useState(laMonthStartISO);
  const [punchTo, setPunchTo] = useState(today);
  const [auditFrom, setAuditFrom] = useState(laMonthStartISO);
  const [auditTo, setAuditTo] = useState(today);
  const [absFrom, setAbsFrom] = useState(laMonthStartISO);
  const [absTo, setAbsTo] = useState(today);

  const exportMut = useMutation({
    mutationFn: async ({
      kind,
      build,
      filename,
    }: {
      kind: string;
      build: () => Promise<string[]>;
      filename: string;
    }) => {
      const lines = await build();
      if (lines.length <= 1) throw new Error("Nothing in that range.");
      downloadCsvFile(filename, lines);
      return { kind, rows: lines.length - 1 };
    },
    onSuccess: ({ rows }) => toast.success(`Export ready — ${rows.toLocaleString()} rows`),
    onError: (e: Error) => toast.error("Export failed", { description: e.message }),
  });

  const running = exportMut.isPending;

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Books &amp; Records
        </div>
        <h1 className="font-display text-xl md:text-2xl text-neon mt-1">Reports</h1>
      </div>

      <Tabs value={tab} onValueChange={(v) => onTabChange(v as ReportsTab)}>
        <TabsList>
          <TabsTrigger value="exports" className="font-display text-[10px] uppercase tracking-widest">
            Exports
          </TabsTrigger>
          <TabsTrigger value="payroll" className="font-display text-[10px] uppercase tracking-widest">
            Payroll
          </TabsTrigger>
        </TabsList>

        <TabsContent value="exports" className="mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ArcadeCard className="p-5 space-y-3">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="w-4 h-4 text-victory" />
                <span className="font-display text-xs uppercase tracking-widest">Payroll — weekly</span>
              </div>
              <p className="text-xs text-muted-foreground">
                One row per person per week. Approved weeks export the FROZEN run (what was paid,
                clawbacks included); other weeks the live pay engine. Dates snap to their Monday.
              </p>
              <RangeInputs from={payrollFrom} to={payrollTo} setFrom={setPayrollFrom} setTo={setPayrollTo} />
              <Button
                disabled={running}
                onClick={() =>
                  exportMut.mutate({
                    kind: "payroll",
                    filename: `payroll-weeks-${weekStartOfISO(payrollFrom)}-to-${weekStartOfISO(payrollTo)}.csv`,
                    build: () =>
                      buildPayrollRangeCsvLines(
                        weekStartsInRange(weekStartOfISO(payrollFrom), weekStartOfISO(payrollTo)),
                      ),
                  })
                }
                className="w-full min-h-11 md:min-h-9 bg-victory text-background hover:bg-victory/90 font-display text-[10px] uppercase tracking-widest"
              >
                <Download className="w-3.5 h-3.5 mr-1.5" />
                Export payroll CSV
              </Button>
            </ArcadeCard>

            <ArcadeCard className="p-5 space-y-3">
              <div className="flex items-center gap-2">
                <FileClock className="w-4 h-4 text-neon" />
                <span className="font-display text-xs uppercase tracking-widest">
                  Punch detail — the time record
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Per person per day: exact clock in/out, meal out/in, billable hours, meal
                compliance, provenance and flags. Voided entries included and marked. This is the
                record California requires — keep exports at least 4 years.
              </p>
              <RangeInputs from={punchFrom} to={punchTo} setFrom={setPunchFrom} setTo={setPunchTo} />
              <Button
                disabled={running}
                onClick={() =>
                  exportMut.mutate({
                    kind: "punch",
                    filename: `time-records-${punchFrom}-to-${punchTo}.csv`,
                    build: () => buildPunchDetailCsvLines(punchFrom, punchTo),
                  })
                }
                className="w-full min-h-11 md:min-h-9 bg-victory text-background hover:bg-victory/90 font-display text-[10px] uppercase tracking-widest"
              >
                <Download className="w-3.5 h-3.5 mr-1.5" />
                Export time records CSV
              </Button>
            </ArcadeCard>

            <ArcadeCard className="p-5 space-y-3">
              <div className="flex items-center gap-2">
                <ScrollText className="w-4 h-4 text-warning" />
                <span className="font-display text-xs uppercase tracking-widest">Audit log</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Every change to every punch: who, when, the required reason, before → after times.
                Append-only — nothing can be erased from it.
              </p>
              <RangeInputs from={auditFrom} to={auditTo} setFrom={setAuditFrom} setTo={setAuditTo} />
              <Button
                disabled={running}
                onClick={() =>
                  exportMut.mutate({
                    kind: "audit",
                    filename: `time-audit-${auditFrom}-to-${auditTo}.csv`,
                    build: () => buildAuditCsvLines(auditFrom, auditTo),
                  })
                }
                className="w-full min-h-11 md:min-h-9 bg-victory text-background hover:bg-victory/90 font-display text-[10px] uppercase tracking-widest"
              >
                <Download className="w-3.5 h-3.5 mr-1.5" />
                Export audit CSV
              </Button>
            </ArcadeCard>

            <ArcadeCard className="p-5 space-y-3">
              <div className="flex items-center gap-2">
                <CalendarOff className="w-4 h-4 text-turf-cyan" />
                <span className="font-display text-xs uppercase tracking-widest">Absences</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Days off, sick days, no-shows and excused absences — requests and records, with
                who entered and who approved each one.
              </p>
              <RangeInputs from={absFrom} to={absTo} setFrom={setAbsFrom} setTo={setAbsTo} />
              <Button
                disabled={running}
                onClick={() =>
                  exportMut.mutate({
                    kind: "absence",
                    filename: `absences-${absFrom}-to-${absTo}.csv`,
                    build: () => buildAbsenceCsvLines(absFrom, absTo),
                  })
                }
                className="w-full min-h-11 md:min-h-9 bg-victory text-background hover:bg-victory/90 font-display text-[10px] uppercase tracking-widest"
              >
                <Download className="w-3.5 h-3.5 mr-1.5" />
                Export absences CSV
              </Button>
            </ArcadeCard>
          </div>
        </TabsContent>

        <TabsContent value="payroll" className="mt-4">
          {/* Read-only for the bookkeeper: run operations render for the
              Admin tier only (and RLS backstops regardless). */}
          <PayrollLedger />
        </TabsContent>
      </Tabs>
    </div>
  );
}
