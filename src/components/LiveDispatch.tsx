import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { OfficeFilterProvider, OfficeFilterToggle, useOfficeFilter } from "@/components/OfficeFilterContext";
import { Radio, Users, FileSearch, X, Link2, Copy, Check, KeyRound, Eye, EyeOff, AlertTriangle, Lock } from "lucide-react";
import confetti from "canvas-confetti";


type Profile = {
  id: string;
  display_name: string | null;
  office_location: string | null;
  team_id: string | null;
  team_office: string | null;
  role: "canvasser" | "captain";
};


type Metric = {
  id: string;
  canvasser_id: string;
  metric_date: string;
  leads_submitted: number;
  leads_confirmed: number;
  no_answers: number;
  killed: number;
  pending: number;
  office_location: string;
};

const PT_TZ = "America/Los_Angeles";
const PT_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: PT_TZ,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

function ptNow() {
  const parts = Object.fromEntries(
    PT_PARTS.formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour), minute: Number(parts.minute),
  };
}
function addDaysISO(iso: string, delta: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
/** Report date: before 7 PM PT → current PT date; at/after 7 PM PT → next PT date. */
function reportDates() {
  const { year, month, day, hour } = ptNow();
  const currentPT = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const locked = hour >= 19;
  const today = locked ? addDaysISO(currentPT, 1) : currentPT;
  const yday = addDaysISO(today, -1);
  return { today, yday, locked };
}

export function LiveDispatch({ readOnly = false }: { readOnly?: boolean }) {
  return (
    <OfficeFilterProvider>
      <LiveDispatchInner readOnly={readOnly} />
    </OfficeFilterProvider>
  );
}

function LiveDispatchInner({ readOnly }: { readOnly: boolean }) {
  const qc = useQueryClient();
  const [{ today, yday, locked }, setDates] = useState(reportDates);
  const { matches } = useOfficeFilter();
  const confettiFired = useRef(false);

  // Re-evaluate report date every 30s; fire confetti once when we cross 7 PM PT.
  useEffect(() => {
    const tick = () => {
      const next = reportDates();
      setDates((prev) => {
        if (!prev.locked && next.locked && !confettiFired.current) {
          confettiFired.current = true;
          fireEndOfDayConfetti();
        }
        if (prev.today === next.today && prev.locked === next.locked) return prev;
        return next;
      });
    };
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, []);

  const { data: canvassers = [] } = useQuery({
    queryKey: ["dispatch-canvassers"],
    queryFn: async () => {
      const { data: roles } = await supabase
        .from("user_roles")
        .select("user_id, role")
        .in("role", ["canvasser", "captain"]);
      const roleMap = new Map<string, "canvasser" | "captain">();
      (roles ?? []).forEach((r) => {
        const prev = roleMap.get(r.user_id);
        if (prev === "captain") return;
        roleMap.set(r.user_id, r.role as "canvasser" | "captain");
      });
      const ids = Array.from(roleMap.keys());
      if (ids.length === 0) return [] as Profile[];
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name, office_location, team_id, teams:team_id(office_location)")
        .in("id", ids)
        .eq("is_active", true);
      const rows: Profile[] = ((profs ?? []) as Array<{
        id: string;
        display_name: string | null;
        office_location: string | null;
        team_id: string | null;
        teams: { office_location: string | null } | null;
      }>).map((p) => ({
        id: p.id,
        display_name: p.display_name,
        office_location: p.office_location,
        team_id: p.team_id,
        team_office: p.teams?.office_location ?? null,
        role: roleMap.get(p.id) ?? "canvasser",
      }));
      return rows;
    },
  });


  const { data: metrics = [] } = useQuery({
    queryKey: ["daily-metrics", today],
    queryFn: async () => {
      const { data } = await supabase
        .from("daily_metrics")
        .select(
          "id, canvasser_id, metric_date, leads_submitted, leads_confirmed, no_answers, killed, pending, office_location",
        )
        .eq("metric_date", today);
      return (data ?? []) as Metric[];
    },
  });

  const { data: ydayMetrics = [] } = useQuery({
    queryKey: ["daily-metrics", yday],
    queryFn: async () => {
      const { data } = await supabase
        .from("daily_metrics")
        .select("canvasser_id, leads_confirmed, no_answers, killed, pending")
        .eq("metric_date", yday);
      return (data ?? []) as Array<Pick<Metric, "canvasser_id" | "leads_confirmed" | "no_answers" | "killed" | "pending">>;
    },
  });

  // Realtime — instant updates when Monday webhook upserts.
  useEffect(() => {
    const channel = supabase
      .channel("dispatch-daily-metrics")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "daily_metrics" },
        () => {
          qc.invalidateQueries({ queryKey: ["daily-metrics", today] });
          qc.invalidateQueries({ queryKey: ["daily-metrics", yday] });
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [qc, today, yday]);

  const metricMap = useMemo(
    () => Object.fromEntries(metrics.map((m) => [m.canvasser_id, m])),
    [metrics],
  );
  const ydayMap = useMemo(
    () => Object.fromEntries(ydayMetrics.map((m) => [m.canvasser_id, m])),
    [ydayMetrics],
  );

  const visible = useMemo(
    () => canvassers.filter((c) => matches(c.office_location ?? c.team_office)),
    [canvassers, matches],
  );

  // Rows enriched + sorted (desc by Submitted, then Confirmed). Zeros sink.
  const rows = useMemo(() => {
    const enriched = visible.map((c) => {
      const m = metricMap[c.id];
      const conf = m?.leads_confirmed ?? 0;
      const na = m?.no_answers ?? 0;
      const kil = m?.killed ?? 0;
      const pen = m?.pending ?? 0;
      const sub = conf + kil + pen + na;
      const conv = sub > 0 ? Math.round((conf / sub) * 100) : 0;
      return { c, conf, na, kil, pen, sub, conv };
    });
    return enriched.sort((a, b) => {
      if (b.sub !== a.sub) return b.sub - a.sub;
      if (b.conf !== a.conf) return b.conf - a.conf;
      return (a.c.display_name ?? "").localeCompare(b.c.display_name ?? "");
    });
  }, [visible, metricMap]);

  const totals = useMemo(() => {
    let conf = 0, na = 0, kil = 0, pen = 0;
    rows.forEach((r) => { conf += r.conf; na += r.na; kil += r.kil; pen += r.pen; });
    const sub = conf + kil + pen + na;
    const conv = sub > 0 ? Math.round((conf / sub) * 100) : 0;
    return { sub, conf, na, kil, pen, conv };
  }, [rows]);

  // Suspension warning — 0 today AND 0 yesterday.
  const suspensionRows = useMemo(() => {
    return rows.filter((r) => {
      if (r.sub !== 0) return false;
      const y = ydayMap[r.c.id];
      const ySub = (y?.leads_confirmed ?? 0) + (y?.no_answers ?? 0) + (y?.killed ?? 0) + (y?.pending ?? 0);
      return ySub === 0;
    });
  }, [rows, ydayMap]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-victory animate-pulse" />
          <div>
            <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              Live Dispatch · {today}
              {locked && (
                <span className="inline-flex items-center gap-1 text-warning">
                  <Lock className="w-3 h-3" /> 7PM LOCK
                </span>
              )}
            </div>
            <div className="font-display text-sm text-neon mt-0.5">
              {readOnly ? "LEADERBOARD · LIVE" : "READ-ONLY · MONDAY.COM FEED"}
            </div>
          </div>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-2">
            <WebhookLogsButton />
            <OfficeFilterToggle />
          </div>
        )}
      </div>

      {!readOnly && <WebhookUrlBanner />}
      {!readOnly && <MondayTokenCard />}

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <TotalTile label="Submitted" value={totals.sub} accent="neon" />
        <TotalTile label="Pending" value={totals.pen} accent="warning" />
        <TotalTile label="N/A" value={totals.na} accent="muted" />
        <TotalTile label="Confirmed" value={totals.conf} accent="victory" />
        <TotalTile label="Killed" value={totals.kil} accent="danger" />
        <TotalTile label="Conversion" value={`${totals.conv}%`} accent="accent" />
      </div>

      <SuspensionBanner rows={suspensionRows} />

      <div className="arcade-card overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
            <Users className="w-5 h-5" />
            No canvassers in this office yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] font-display uppercase tracking-widest text-muted-foreground border-b border-border bg-surface">
                  <th className="text-left py-2.5 px-3 w-10">#</th>
                  <th className="text-left py-2.5 px-3">Canvasser</th>
                  <th className="text-left py-2.5 px-3">Office</th>
                  <th className="text-right py-2.5 px-3">Submitted</th>
                  <th className="text-right py-2.5 px-3">Pending</th>
                  <th className="text-right py-2.5 px-3">N/A</th>
                  <th className="text-right py-2.5 px-3">Confirmed</th>
                  <th className="text-right py-2.5 px-3">Killed</th>
                  <th className="text-right py-2.5 px-3">Conversion %</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const isFire = r.sub > 0;
                  const emoji = isFire ? "🔥" : "🍩";
                  return (
                    <tr key={r.c.id} className="border-b border-border/40 hover:bg-gray-800/50 transition-colors">
                      <td className="py-2.5 px-3 text-muted-foreground font-display text-xs">
                        {i + 1}
                      </td>
                      <td className="py-2.5 px-3 font-medium">
                        <span className="mr-2 inline-block" aria-hidden>{emoji}</span>
                        {r.c.display_name ?? "—"}
                        {r.c.role === "captain" && (
                          <span className="ml-2 text-[9px] font-display uppercase tracking-widest text-accent">
                            Captain
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-xs text-muted-foreground">
                        {r.c.office_location ?? r.c.team_office ?? "—"}
                      </td>
                      <MetricCell value={r.sub} color="neon" />
                      <MetricCell value={r.pen} color="warning" />
                      <MetricCell value={r.na} color="muted-foreground" />
                      <MetricCell value={r.conf} color="victory" />
                      <MetricCell value={r.kil} color="destructive" />
                      <MetricCell value={r.conv} color="accent" suffix="%" />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function SuspensionBanner({ rows }: { rows: Array<{ c: Profile }> }) {
  if (rows.length === 0) return null;
  return (
    <div className="arcade-card p-4 border-destructive/60 bg-destructive/10">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="w-4 h-4 text-destructive animate-pulse" />
        <div className="font-display text-sm text-destructive uppercase tracking-widest">
          🚨 Suspension Warning · 2+ Zeros
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {rows.map((r) => (
          <div
            key={r.c.id}
            className="flex items-center gap-2 arcade-card px-3 py-1.5 border-destructive/40"
          >
            <span
              className="inline-block grayscale animate-[frozen-shake_0.35s_infinite]"
              aria-hidden
            >
              🍩
            </span>
            <span className="text-sm font-medium">{r.c.display_name ?? "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function fireEndOfDayConfetti() {
  const duration = 3000;
  const end = Date.now() + duration;
  const colors = ["#39FF14", "#00E5FF", "#FF7A00", "#FF3366"];
  (function frame() {
    confetti({ particleCount: 4, angle: 60, spread: 55, origin: { x: 0 }, colors });
    confetti({ particleCount: 4, angle: 120, spread: 55, origin: { x: 1 }, colors });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
}



const metricColorClass = {
  neon: "text-neon",
  warning: "text-warning",
  "muted-foreground": "text-muted-foreground",
  victory: "text-victory",
  destructive: "text-destructive",
  accent: "text-accent",
};

function MetricCell({
  value,
  color,
  suffix = "",
}: {
  value: number;
  color: "neon" | "warning" | "muted-foreground" | "victory" | "destructive" | "accent";
  suffix?: string;
}) {
  const active = value > 0;
  const colorClass = active ? metricColorClass[color] : "text-muted-foreground/40";
  return (
    <td className={`py-2.5 px-3 text-right font-display ${colorClass}`}>
      {value}{suffix}
    </td>
  );
}

function WebhookUrlBanner() {
  const [copied, setCopied] = useState(false);
  // Direct backend Edge Function URL — bypasses the frontend entirely so
  // Monday.com receives a naked JSON challenge response, not HTML.
  const supabaseUrl =
    (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "";
  const anonKey =
    (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ?? "";
  const url = supabaseUrl
    ? `${supabaseUrl.replace(/\/$/, "")}/functions/v1/monday-live-dispatch${anonKey ? `?apikey=${encodeURIComponent(anonKey)}` : ""}`
    : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="arcade-card p-4 border-accent/40">
      <div className="flex items-center gap-2 mb-2">
        <Link2 className="w-4 h-4 text-accent" />
        <div className="text-[10px] font-display uppercase tracking-widest text-accent">
          Webhook Integration URL · Direct Backend
        </div>
      </div>
      <div className="text-xs text-muted-foreground mb-3">
        Paste this raw backend URL into Monday.com. It returns naked JSON for the
        challenge handshake. Send POST with{" "}
        <code className="text-foreground">{`{ canvasser_name, status }`}</code> and the
        header <code className="text-foreground">x-monday-secret</code>.
      </div>
      <div className="flex flex-col sm:flex-row gap-2 items-stretch">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 bg-surface border border-border rounded px-3 py-2 text-xs font-mono text-neon overflow-x-auto"
        />
        <button
          type="button"
          onClick={copy}
          className="arcade-card px-3 py-2 text-[10px] font-display uppercase tracking-widest text-accent hover:bg-surface-elevated flex items-center justify-center gap-2"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function MondayTokenCard() {
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["system-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("system_settings")
        .select("monday_api_token, updated_at")
        .eq("id", true)
        .maybeSingle();
      if (error) throw error;
      return data as { monday_api_token: string | null; updated_at: string } | null;
    },
  });

  const hasToken = !!data?.monday_api_token;

  const save = async () => {
    setSaving(true);
    setError(null);
    const { error } = await supabase
      .from("system_settings")
      .upsert({ id: true, monday_api_token: value.trim() || null }, { onConflict: "id" });
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    setValue("");
    setSavedAt(Date.now());
    qc.invalidateQueries({ queryKey: ["system-settings"] });
  };

  return (
    <div className="arcade-card p-4 border-warning/40">
      <div className="flex items-center gap-2 mb-2">
        <KeyRound className="w-4 h-4 text-warning" />
        <div className="text-[10px] font-display uppercase tracking-widest text-warning">
          Monday.com API Token
        </div>
        {hasToken && (
          <span className="ml-auto text-[10px] font-display uppercase tracking-widest text-victory">
            ✓ Configured
          </span>
        )}
      </div>
      <div className="text-xs text-muted-foreground mb-3">
        Required for the webhook to look up the canvasser name from Monday when
        only <code className="text-foreground">pulseId</code> is sent. Stored
        securely (owners only).
      </div>
      <div className="flex flex-col sm:flex-row gap-2 items-stretch">
        <div className="relative flex-1">
          <input
            type={reveal ? "text" : "password"}
            placeholder={
              isLoading
                ? "Loading…"
                : hasToken
                  ? "Enter new token to replace existing"
                  : "Paste Monday API token"
            }
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full bg-surface border border-border rounded px-3 py-2 pr-10 text-xs font-mono text-neon"
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label={reveal ? "Hide token" : "Show token"}
          >
            {reveal ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
        <button
          type="button"
          onClick={save}
          disabled={saving || !value.trim()}
          className="arcade-card px-3 py-2 text-[10px] font-display uppercase tracking-widest text-warning hover:bg-surface-elevated disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save Token"}
        </button>
      </div>
      {error && (
        <div className="mt-2 text-[11px] text-destructive font-mono">{error}</div>
      )}
      {savedAt && !error && (
        <div className="mt-2 text-[11px] text-victory font-display uppercase tracking-widest">
          Saved
        </div>
      )}
    </div>
  );
}

function TotalTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent: "neon" | "victory" | "accent" | "warning" | "danger" | "muted";
}) {
  const color =
    accent === "victory"
      ? "text-victory"
      : accent === "accent"
        ? "text-accent"
        : accent === "warning"
          ? "text-warning"
          : accent === "danger"
            ? "text-destructive"
            : accent === "muted"
              ? "text-muted-foreground"
              : "text-neon";
  return (
    <div className="arcade-card p-4">
      <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className={`font-display text-2xl mt-1 ${color}`}>{value}</div>
    </div>
  );
}

type WebhookLog = {
  id: string;
  created_at: string;
  source: string | null;
  step: string | null;
  data: unknown;
  raw_payload: unknown;
};

function WebhookLogsButton() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: logs = [], refetch, isFetching } = useQuery({
    queryKey: ["webhook-logs"],
    enabled: open,
    queryFn: async () => {
      const { data } = await supabase
        .from("webhook_logs")
        .select("id, created_at, source, step, data, raw_payload")
        .order("created_at", { ascending: false })
        .limit(50);
      return (data ?? []) as WebhookLog[];
    },
  });

  // Realtime — new webhook_logs rows pop in instantly.
  useEffect(() => {
    if (!open) return;
    const channel = supabase
      .channel("webhook-logs-live")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "webhook_logs" },
        () => qc.invalidateQueries({ queryKey: ["webhook-logs"] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [open, qc]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="arcade-card px-3 py-2 text-[10px] font-display uppercase tracking-widest text-accent hover:bg-surface-elevated flex items-center gap-2"
      >
        <FileSearch className="w-3.5 h-3.5" />
        Webhook Logs
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="arcade-card w-full max-w-3xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div>
                <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  X-Ray · Raw Incoming Payloads
                </div>
                <div className="font-display text-sm text-neon mt-0.5">
                  WEBHOOK LOGS · LIVE (LAST 50)
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => refetch()}
                  className="text-[10px] font-display uppercase tracking-widest text-accent px-2 py-1 hover:bg-surface-elevated rounded"
                >
                  {isFetching ? "…" : "Refresh"}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="overflow-y-auto p-4 space-y-3">
              {logs.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-8">
                  No webhook payloads received yet.
                </div>
              ) : (
                logs.map((l) => (
                  <div key={l.id} className="border border-border rounded p-3 bg-surface">
                    <div className="flex justify-between text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
                      <span className="text-neon">{l.step ?? l.source ?? "unknown"}</span>
                      <span>{new Date(l.created_at).toLocaleString()}</span>
                    </div>
                    <pre className="text-[11px] font-mono text-foreground whitespace-pre-wrap break-all max-h-64 overflow-auto">
{JSON.stringify(l.data ?? l.raw_payload ?? {}, null, 2)}
                    </pre>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

