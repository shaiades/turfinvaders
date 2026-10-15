import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarOff, Download, Eye, FileClock, FileSpreadsheet, ScrollText } from "lucide-react";
import { ArcadeCard } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import { PAYROLL_READ_ROLES } from "@/lib/role-policy";
import { PayrollLedger } from "@/components/PayrollLedger";
import { ReportViewer } from "@/components/ReportViewer";
import { supabase } from "@/integrations/supabase/client";
import { downloadCsvFile } from "@/lib/csv";
import {
  buildAbsenceTable,
  buildAuditTable,
  buildPayrollRangeTable,
  buildPunchDetailTable,
  reportTableToCsvLines,
  weekStartsInRange,
  type ExportFilter,
  type ReportTable,
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
  // HR reads attendance, never dollars: the Payroll tab/card hide for roles
  // outside the payroll-read tier (RLS + the paycheck server fns enforce the
  // same boundary regardless of what renders).
  const { role } = useAuth();
  const payrollAccess = !!role && (PAYROLL_READ_ROLES as readonly string[]).includes(role);
  const effectiveTab: ReportsTab = payrollAccess ? tab : "exports";
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
  // Who the payroll / punch / absence exports cover: everyone (default), a
  // van, or one person. The audit export stays unfiltered — it is the
  // tamper-evident record, exported whole.
  const [personId, setPersonId] = useState("all");
  const [teamFilterId, setTeamFilterId] = useState("all");

  const roster = useQuery({
    queryKey: ["reports-roster"],
    queryFn: async () => {
      const [profilesRes, teamsRes] = await Promise.all([
        supabase.from("profiles").select("id, display_name, team_id").order("display_name"),
        supabase.from("teams").select("id, name").order("name"),
      ]);
      if (profilesRes.error) throw profilesRes.error;
      if (teamsRes.error) throw teamsRes.error;
      return { profiles: profilesRes.data ?? [], teams: teamsRes.data ?? [] };
    },
  });

  const exportFilter: ExportFilter = useMemo(() => {
    if (personId !== "all") return [personId];
    if (teamFilterId !== "all") {
      return (roster.data?.profiles ?? [])
        .filter((p) => p.team_id === teamFilterId)
        .map((p) => p.id);
    }
    return undefined;
  }, [personId, teamFilterId, roster.data?.profiles]);
  const filterSlug =
    personId !== "all"
      ? `-${(roster.data?.profiles.find((p) => p.id === personId)?.display_name ?? "person")
          .replace(/[^a-z0-9]+/gi, "-")
          .toLowerCase()}`
      : teamFilterId !== "all"
        ? `-${(roster.data?.teams.find((t) => t.id === teamFilterId)?.name ?? "van")
            .replace(/[^a-z0-9]+/gi, "-")
            .toLowerCase()}`
        : "";

  // One builder serves both verbs: View renders the table on screen,
  // Export downloads the identical rows as CSV.
  const [preview, setPreview] = useState<{
    title: string;
    filename: string;
    table: ReportTable;
  } | null>(null);

  const reportMut = useMutation({
    mutationFn: async ({
      action,
      title,
      build,
      filename,
    }: {
      action: "view" | "export";
      title: string;
      build: () => Promise<ReportTable>;
      filename: string;
    }) => {
      const table = await build();
      if (table.rows.length === 0) throw new Error("Nothing in that range.");
      return { action, title, filename, table };
    },
    onSuccess: ({ action, title, filename, table }) => {
      if (action === "export") {
        downloadCsvFile(filename, reportTableToCsvLines(table));
        toast.success(`Export ready — ${table.rows.length.toLocaleString()} rows`);
      } else {
        setPreview({ title, filename, table });
      }
    },
    onError: (e: Error) => toast.error("Couldn't build that report", { description: e.message }),
  });

  const running = reportMut.isPending;

  /** The View + Export button pair every report card ends with. */
  const reportButtons = (title: string, filename: string, build: () => Promise<ReportTable>) => (
    <div className="flex flex-col sm:flex-row gap-2">
      <Button
        disabled={running}
        onClick={() => reportMut.mutate({ action: "view", title, filename, build })}
        className="flex-1 min-h-11 md:min-h-9 bg-victory text-background hover:bg-victory/90 font-display text-[10px] uppercase tracking-widest"
      >
        <Eye className="w-3.5 h-3.5 mr-1.5" />
        View on screen
      </Button>
      <Button
        disabled={running}
        variant="outline"
        onClick={() => reportMut.mutate({ action: "export", title, filename, build })}
        className="flex-1 min-h-11 md:min-h-9 font-display text-[10px] uppercase tracking-widest"
      >
        <Download className="w-3.5 h-3.5 mr-1.5" />
        CSV
      </Button>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Books &amp; Records
        </div>
        <h1 className="font-display text-xl md:text-2xl text-neon mt-1">Reports</h1>
      </div>

      <Tabs value={effectiveTab} onValueChange={(v) => onTabChange(v as ReportsTab)}>
        <TabsList>
          <TabsTrigger value="exports" className="font-display text-[10px] uppercase tracking-widest">
            Exports
          </TabsTrigger>
          {payrollAccess && (
            <TabsTrigger
              value="payroll"
              className="font-display text-[10px] uppercase tracking-widest"
            >
              Payroll
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="exports" className="mt-4 space-y-4">
          <ArcadeCard className="p-4 flex flex-wrap items-end gap-3">
            <label className="block space-y-1 w-full sm:w-56">
              <span className={FIELD_LABEL}>Van filter</span>
              <Select
                value={teamFilterId}
                onValueChange={(v) => {
                  setTeamFilterId(v);
                  setPersonId("all");
                }}
              >
                <SelectTrigger className="text-base md:text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[10000]">
                  <SelectItem value="all">All vans</SelectItem>
                  {(roster.data?.teams ?? []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="block space-y-1 w-full sm:w-56">
              <span className={FIELD_LABEL}>Person filter</span>
              <Select value={personId} onValueChange={setPersonId}>
                <SelectTrigger className="text-base md:text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[10000] max-h-72">
                  <SelectItem value="all">Everyone</SelectItem>
                  {(roster.data?.profiles ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <div className="text-[10px] text-muted-foreground pb-2">
              Applies to the payroll, punch-detail and absence reports. The audit log always runs
              whole.
            </div>
          </ArcadeCard>

          {preview && (
            <ReportViewer
              title={preview.title}
              table={preview.table}
              onDownload={() =>
                downloadCsvFile(preview.filename, reportTableToCsvLines(preview.table))
              }
              onClose={() => setPreview(null)}
            />
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {payrollAccess && (
              <ArcadeCard className="p-5 space-y-3">
                <div className="flex items-center gap-2">
                  <FileSpreadsheet className="w-4 h-4 text-victory" />
                  <span className="font-display text-xs uppercase tracking-widest">
                    Payroll — weekly
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  One row per person per week. Approved weeks export the FROZEN run (what was paid,
                  clawbacks included); other weeks the live pay engine. Dates snap to their Monday.
                </p>
                <RangeInputs
                  from={payrollFrom}
                  to={payrollTo}
                  setFrom={setPayrollFrom}
                  setTo={setPayrollTo}
                />
                {reportButtons(
                  "Payroll — weekly",
                  `payroll-weeks-${weekStartOfISO(payrollFrom)}-to-${weekStartOfISO(payrollTo)}${filterSlug}.csv`,
                  () =>
                    buildPayrollRangeTable(
                      weekStartsInRange(weekStartOfISO(payrollFrom), weekStartOfISO(payrollTo)),
                      exportFilter,
                    ),
                )}
              </ArcadeCard>
            )}

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
              {reportButtons(
                "Punch detail",
                `time-records-${punchFrom}-to-${punchTo}${filterSlug}.csv`,
                () => buildPunchDetailTable(punchFrom, punchTo, exportFilter),
              )}
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
              {reportButtons("Audit log", `time-audit-${auditFrom}-to-${auditTo}.csv`, () =>
                buildAuditTable(auditFrom, auditTo),
              )}
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
              {reportButtons("Absences", `absences-${absFrom}-to-${absTo}${filterSlug}.csv`, () =>
                buildAbsenceTable(absFrom, absTo, exportFilter),
              )}
            </ArcadeCard>
          </div>
        </TabsContent>

        {payrollAccess && (
          <TabsContent value="payroll" className="mt-4">
            {/* Read-only for the bookkeeper: run operations render for the
                Admin tier only (and RLS backstops regardless). */}
            <PayrollLedger />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
