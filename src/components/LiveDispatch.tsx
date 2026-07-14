import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { OfficeFilterProvider, OfficeFilterToggle, useOfficeFilter } from "@/components/OfficeFilterContext";
import { Radio, Users, FileSearch, X, Link2, Copy, Check, KeyRound, Eye, EyeOff } from "lucide-react";


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

function todayLA(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

export function LiveDispatch() {
  return (
    <OfficeFilterProvider>
      <LiveDispatchInner />
    </OfficeFilterProvider>
  );
}

function LiveDispatchInner() {
  const qc = useQueryClient();
  const today = todayLA();
  const { matches } = useOfficeFilter();

  const { data: canvassers = [] } = useQuery({
    queryKey: ["dispatch-canvassers"],
    queryFn: async () => {
      const { data: roles } = await supabase
        .from("user_roles")
        .select("user_id, role")
        .in("role", ["canvasser", "captain"]);
      const roleMap = new Map<string, "canvasser" | "captain">();
      (roles ?? []).forEach((r) => {
        // Captain wins if a user somehow has both (canvasser is default).
        const prev = roleMap.get(r.user_id);
        if (prev === "captain") return;
        roleMap.set(r.user_id, r.role as "canvasser" | "captain");
      });
      const ids = Array.from(roleMap.keys());
      if (ids.length === 0) return [] as Profile[];
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name, office_location, team_id, teams:team_id(office_location)")
        .in("id", ids);
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
      return rows.sort((a, b) =>
        (a.display_name ?? "").localeCompare(b.display_name ?? ""),
      );
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

  // Realtime subscription — instant updates when Monday webhook upserts.
  useEffect(() => {
    const channel = supabase
      .channel("dispatch-daily-metrics")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "daily_metrics" },
        () => qc.invalidateQueries({ queryKey: ["daily-metrics", today] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc, today]);

  const metricMap = useMemo(
    () => Object.fromEntries(metrics.map((m) => [m.canvasser_id, m])),
    [metrics],
  );

  const visible = useMemo(
    () => canvassers.filter((c) => matches(c.office_location ?? c.team_office)),
    [canvassers, matches],
  );


  const totals = useMemo(() => {
    let conf = 0, na = 0, kil = 0, pen = 0;
    visible.forEach((c) => {
      const m = metricMap[c.id];
      if (!m) return;
      conf += m.leads_confirmed ?? 0;
      na += m.no_answers ?? 0;
      kil += m.killed ?? 0;
      pen += m.pending ?? 0;
    });
    const sub = conf + kil + pen + na;
    const conv = sub > 0 ? Math.round((conf / sub) * 100) : 0;
    return { sub, conf, na, kil, pen, conv };
  }, [visible, metricMap]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-victory animate-pulse" />
          <div>
            <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              Live Dispatch · {today}
            </div>
            <div className="font-display text-sm text-neon mt-0.5">
              READ-ONLY · MONDAY.COM FEED
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <WebhookLogsButton />
          <OfficeFilterToggle />
        </div>
      </div>


      <WebhookUrlBanner />
      <MondayTokenCard />

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">

        <TotalTile label="Submitted" value={totals.sub} accent="neon" />
        <TotalTile label="Pending" value={totals.pen} accent="warning" />
        <TotalTile label="N/A" value={totals.na} accent="muted" />
        <TotalTile label="Confirmed" value={totals.conf} accent="victory" />
        <TotalTile label="Killed" value={totals.kil} accent="danger" />
        <TotalTile label="Conversion" value={`${totals.conv}%`} accent="accent" />
      </div>

      <div className="arcade-card overflow-hidden">
        {visible.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
            <Users className="w-5 h-5" />
            No canvassers in this office yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] font-display uppercase tracking-widest text-muted-foreground border-b border-border bg-surface">
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
                {visible.map((c) => {
                  const m = metricMap[c.id];
                  const conf = m?.leads_confirmed ?? 0;
                  const na = m?.no_answers ?? 0;
                  const kil = m?.killed ?? 0;
                  const pen = m?.pending ?? 0;
                  const sub = conf + kil + pen + na;
                  const conv = sub > 0 ? Math.round((conf / sub) * 100) : 0;
                  return (
                    <tr key={c.id} className="border-b border-border/40 hover:bg-gray-800/50 transition-colors">
                      <td className="py-2.5 px-3 font-medium">
                        {c.display_name ?? "—"}
                        {c.role === "captain" && (
                          <span className="ml-2 text-[9px] font-display uppercase tracking-widest text-accent">
                            Captain
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-xs text-muted-foreground">
                        {c.office_location ?? c.team_office ?? "—"}
                      </td>

                      <MetricCell value={sub} color="neon" />
                      <MetricCell value={pen} color="warning" />
                      <MetricCell value={na} color="muted-foreground" />
                      <MetricCell value={conf} color="victory" />
                      <MetricCell value={kil} color="destructive" />
                      <MetricCell value={conv} color="accent" suffix="%" />
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

