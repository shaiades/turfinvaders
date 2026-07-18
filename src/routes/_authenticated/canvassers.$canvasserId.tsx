import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { StatCard, ArcadePanel, TeamBadge } from "@/components/arcade";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency } from "@/lib/utils";
import { weekStartMonday, toISODate } from "@/lib/dates";
import { Lock, EyeOff } from "lucide-react";

export const Route = createFileRoute("/_authenticated/canvassers/$canvasserId")({
  head: () => ({ meta: [{ title: "Player profile — Knockout" }] }),
  component: CanvasserProfile,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function startOfMonthISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.toISOString();
}

function CanvasserProfile() {
  const { canvasserId } = Route.useParams();
  const { role, teamId, user } = useAuth();
  const isRealUser = UUID_RE.test(canvasserId);

  const { data: settings } = useQuery({
    queryKey: ["company_settings"],
    queryFn: async () => (await supabase.from("company_settings").select("*").maybeSingle()).data,
  });

  const profileQuery = useQuery({
    enabled: isRealUser,
    queryKey: ["canvasser_profile", canvasserId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("display_name, team_id, level")
        .eq("id", canvasserId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const profileTeamId = profileQuery.data?.team_id ?? null;

  const teamQuery = useQuery({
    enabled: !!profileTeamId,
    queryKey: ["canvasser_profile_team", profileTeamId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("teams")
        .select("id, name, color")
        .eq("id", profileTeamId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // Real revenue from confirmed leads (Monday-anchored week, matching the rest of the app)
  const revenueQuery = useQuery({
    enabled: isRealUser,
    queryKey: ["canvasser_revenue", canvasserId],
    queryFn: async () => {
      const monday = weekStartMonday().toISOString();
      const [weekRes, monthRes] = await Promise.all([
        supabase
          .from("leads")
          .select("sale_amount")
          .eq("canvasser_id", canvasserId)
          .eq("status", "confirmed")
          .eq("is_sale", true)
          .gte("created_at", monday),
        supabase
          .from("leads")
          .select("sale_amount")
          .eq("canvasser_id", canvasserId)
          .eq("status", "confirmed")
          .eq("is_sale", true)
          .gte("created_at", startOfMonthISO()),
      ]);
      if (weekRes.error) throw weekRes.error;
      if (monthRes.error) throw monthRes.error;
      const sum = (rows: { sale_amount: number | null }[] | null) =>
        (rows ?? []).reduce((a, r) => a + Number(r.sale_amount ?? 0), 0);
      return { weekly: sum(weekRes.data), monthly: sum(monthRes.data) };
    },
  });

  const isSelf = !!user && user.id === canvasserId;
  const sameTeam = teamId && profileTeamId && teamId === profileTeamId;
  const visibility = !!settings?.global_visibility;

  // VISIBILITY of the profile itself
  const canViewFull =
    role === "owner" ||
    role === "office_staff" ||
    role === "captain" ||
    isSelf ||
    sameTeam ||
    visibility;

  // Who may read this player's daily_logs (mirrors the "daily_logs read scoped" RLS
  // policy — peers get zero rows back, so don't render fake zeros for them).
  const directCaptainQuery = useQuery({
    enabled: role === "captain" && !!profileTeamId && !isSelf,
    queryKey: ["is_direct_captain", profileTeamId, user?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("teams")
        .select("captain_id")
        .eq("id", profileTeamId!)
        .maybeSingle();
      return data?.captain_id === user?.id;
    },
  });
  const isDirectCaptain = !!directCaptainQuery.data;
  const canReadLogs =
    isSelf ||
    role === "owner" ||
    role === "office_staff" ||
    (role === "captain" && isDirectCaptain);
  const canViewRevenue = canReadLogs;

  // Week-to-date production stats from real daily_logs
  const statsQuery = useQuery({
    enabled: isRealUser && canReadLogs,
    queryKey: ["canvasser_stats", canvasserId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("daily_logs")
        .select("doors_knocked, people_talked_to, sales")
        .eq("canvasser_id", canvasserId)
        .gte("log_date", toISODate(weekStartMonday()));
      if (error) throw error;
      return (data ?? []).reduce(
        (acc, r) => ({
          doors: acc.doors + (r.doors_knocked ?? 0),
          contacts: acc.contacts + (r.people_talked_to ?? 0),
          sales: acc.sales + (r.sales ?? 0),
        }),
        { doors: 0, contacts: 0, sales: 0 },
      );
    },
  });

  if (!isRealUser) throw notFound();

  const team = teamQuery.data;
  const level = profileQuery.data?.level ?? 0;
  const stats = statsQuery.data;
  const weekly = revenueQuery.data?.weekly ?? 0;
  const monthly = revenueQuery.data?.monthly ?? 0;

  return (
    <div className="space-y-8">
      <div>
        {team ? (
          <Link
            to="/teams/$teamId"
            params={{ teamId: team.id }}
            className="text-xs text-muted-foreground hover:text-neon"
          >
            ← Back to {team.name}
          </Link>
        ) : null}
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <h1 className="font-display text-2xl text-neon">
            {(profileQuery.data?.display_name ?? "PLAYER").toUpperCase()}
          </h1>
          {team && <TeamBadge name={team.name} color={team.color ?? "#10b981"} />}
          {level > 0 && <span className="text-[10px] font-display text-victory">LVL {level}</span>}
          {(role === "owner" || role === "office_staff" || role === "captain" || isSelf) && (
            <Link
              to="/canvassers/$canvasserId/field"
              params={{ canvasserId }}
              className="ml-auto inline-flex items-center gap-2 rounded border border-neon/50 bg-neon/10 px-3 py-1.5 text-[10px] font-display uppercase tracking-widest text-neon hover:bg-neon/20 transition"
            >
              👁 View Field Activity
            </Link>
          )}
        </div>
      </div>

      {!canViewFull ? (
        <div className="arcade-card p-8 text-center">
          <Lock className="w-6 h-6 mx-auto text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            This player's profile is private. Ask the Owner to enable Global Visibility to see peer
            stats.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              label="Doors Knocked"
              value={canReadLogs && stats ? stats.doors.toLocaleString() : "—"}
              sublabel="Week to date"
              accent="neon"
            />
            <StatCard
              label="Contacts Made"
              value={canReadLogs && stats ? stats.contacts.toLocaleString() : "—"}
              sublabel="Week to date"
              accent="warning"
            />
            <StatCard
              label="Sales Closed"
              value={canReadLogs && stats ? stats.sales.toLocaleString() : "—"}
              sublabel="Week to date"
              accent="accent"
            />
            <StatCard
              label="Revenue Generated"
              value={canViewRevenue ? formatCurrency(monthly) : "—"}
              sublabel="Month to date"
              accent="victory"
            />
          </div>

          {canViewRevenue ? (
            <ArcadePanel title="Revenue · Confirmed Sales">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <StatCard
                  label="Weekly Revenue"
                  value={formatCurrency(weekly)}
                  accent="victory"
                  sublabel="Since Monday · confirmed sales only"
                />
                <StatCard
                  label="Monthly Revenue"
                  value={formatCurrency(monthly)}
                  accent="victory"
                  sublabel="Month-to-date · confirmed sales only"
                />
              </div>
            </ArcadePanel>
          ) : (
            <ArcadePanel title="Revenue · Confirmed Sales">
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <EyeOff className="w-4 h-4" />
                Revenue is hidden on peer profiles. You see production metrics only.
              </div>
            </ArcadePanel>
          )}

          {canReadLogs && stats && stats.doors > 0 ? (
            <ArcadePanel title="Conversion Funnel">
              <div className="space-y-3">
                <FunnelRow label="Doors knocked" value={stats.doors} max={stats.doors} />
                <FunnelRow label="Contacts made" value={stats.contacts} max={stats.doors} />
                <FunnelRow label="Sales closed" value={stats.sales} max={stats.doors} />
              </div>
              <div className="mt-4 text-xs text-muted-foreground">
                Close rate ·{" "}
                <span className="text-victory font-display">
                  {stats.contacts > 0 ? ((stats.sales / stats.contacts) * 100).toFixed(1) : "0.0"}%
                </span>
              </div>
            </ArcadePanel>
          ) : !canReadLogs ? (
            <ArcadePanel title="Conversion Funnel">
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <EyeOff className="w-4 h-4" />
                Detailed production stats are visible to the player, their captain, and the office.
              </div>
            </ArcadePanel>
          ) : null}
        </>
      )}
    </div>
  );
}

function FunnelRow({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max ? (value / max) * 100 : 0;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{value.toLocaleString()}</span>
      </div>
      <div className="h-2 bg-surface-elevated rounded">
        <div className="h-full rounded bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
