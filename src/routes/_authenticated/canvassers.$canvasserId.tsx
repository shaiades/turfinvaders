import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { StatCard, ArcadePanel, TeamBadge, ArcadeCard } from "@/components/arcade";
import { useAuth } from "@/hooks/useAuth";
import { isAdminRole, isManagerRole, MANAGER_ROLES, requireRoleBeforeLoad } from "@/lib/roles";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency } from "@/lib/utils";
import { useDateRange } from "@/hooks/useDateRange";
import { RangeTabs } from "@/components/RangeTabs";
import {
  DoorResultsGrid,
  FunnelStageBars,
  funnelStages,
  type PinRowLite,
} from "@/components/ConversionPanels";
import { Lock, EyeOff } from "lucide-react";

export const Route = createFileRoute("/_authenticated/canvassers/$canvasserId")({
  head: () => ({ meta: [{ title: "Player profile — Knockout" }] }),
  // Leadership-only: canvassers/sales reps bounce in beforeLoad (real DB
  // roles) before any queries fire. Also gates the /field child route.
  beforeLoad: requireRoleBeforeLoad(MANAGER_ROLES),
  component: CanvasserProfile,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Month starts at midnight America/Los_Angeles on the 1st (LA calendar).

function CanvasserProfile() {
  const { canvasserId } = Route.useParams();
  const { role, teamId, user } = useAuth();
  const isRealUser = UUID_RE.test(canvasserId);
  // Day / Week / Month selector — defaults to the pay week (the old fixed
  // "week to date" anchor) and drives both production stats and revenue.
  const rangeControls = useDateRange({ initialTab: "week" });
  const { range } = rangeControls;

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

  // Real revenue from confirmed leads, scoped to the selected range (leads
  // are timestamptz, so the window is the range's LA-midnight UTC instants).
  const revenueQuery = useQuery({
    enabled: isRealUser,
    queryKey: ["canvasser_revenue", canvasserId, range.startISO, range.endISO],
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leads")
        .select("sale_amount")
        .eq("canvasser_id", canvasserId)
        .eq("status", "confirmed")
        .eq("is_sale", true)
        .gte("created_at", range.startUtcISO)
        .lt("created_at", range.endUtcExclusiveISO);
      if (error) throw error;
      return (data ?? []).reduce((a, r) => a + Number(r.sale_amount ?? 0), 0);
    },
  });

  const isSelf = !!user && user.id === canvasserId;
  const sameTeam = teamId && profileTeamId && teamId === profileTeamId;
  const visibility = !!settings?.global_visibility;

  // VISIBILITY of the profile itself
  const canViewFull = isManagerRole(role) || isSelf || sameTeam || visibility;

  // Who may read this player's daily_logs — mirrors the "daily_logs read
  // scoped" RLS policy since 20260803010000: self, Admins, and ANY captain
  // (role-based global reads; /teams/$teamId already shows every captain any
  // van's logs). Peers get zero rows back, so don't render fake zeros for them.
  const canReadLogs = isSelf || isAdminRole(role) || role === "captain";
  const canViewRevenue = canReadLogs;

  // Production stats from real daily_logs, scoped to the selected range.
  const statsQuery = useQuery({
    enabled: isRealUser && canReadLogs,
    queryKey: ["canvasser_stats", canvasserId, range.startISO, range.endISO],
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("daily_logs")
        .select("doors_knocked, people_talked_to, confirmed_leads, demos_sits, sales")
        .eq("canvasser_id", canvasserId)
        .gte("log_date", range.startISO)
        .lte("log_date", range.endISO);
      if (error) throw error;
      return (data ?? []).reduce(
        (acc, r) => ({
          doors: acc.doors + (r.doors_knocked ?? 0),
          contacts: acc.contacts + (r.people_talked_to ?? 0),
          leads: acc.leads + (r.confirmed_leads ?? 0),
          sits: acc.sits + (r.demos_sits ?? 0),
          sales: acc.sales + (r.sales ?? 0),
        }),
        { doors: 0, contacts: 0, leads: 0, sits: 0, sales: 0 },
      );
    },
  });

  // What happened at this player's doors, result by result (same range).
  const pinsQuery = useQuery({
    enabled: isRealUser && canReadLogs,
    queryKey: ["canvasser_pins_range", canvasserId, range.startISO, range.endISO],
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("field_pins")
        .select("pin_type, is_remote_drop")
        .eq("canvasser_id", canvasserId)
        .gte("log_date", range.startISO)
        .lte("log_date", range.endISO);
      if (error) throw error;
      return (data ?? []) as PinRowLite[];
    },
  });

  if (!isRealUser) throw notFound();

  const team = teamQuery.data;
  const level = profileQuery.data?.level ?? 0;
  const stats = statsQuery.data;
  const revenue = revenueQuery.data ?? 0;

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
          {(isManagerRole(role) || isSelf) && (
            <Link
              to="/canvassers/$canvasserId/field"
              params={{ canvasserId }}
              className="ml-auto inline-flex items-center gap-2 rounded border border-neon/50 bg-neon/10 px-3 py-2 min-h-10 text-xs font-display uppercase tracking-widest text-neon hover:bg-neon/20 transition"
            >
              👁 View Field Activity
            </Link>
          )}
        </div>
      </div>

      {!canViewFull ? (
        <ArcadeCard className="p-8 text-center">
          <Lock className="w-6 h-6 mx-auto text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            This player's profile is private. Ask the Owner to enable Global Visibility to see peer
            stats.
          </p>
        </ArcadeCard>
      ) : (
        <>
          <RangeTabs controls={rangeControls} />

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              label="Doors Knocked"
              value={canReadLogs && stats ? stats.doors.toLocaleString() : "—"}
              sublabel={range.label}
              accent="neon"
            />
            <StatCard
              label="Contacts Made"
              value={canReadLogs && stats ? stats.contacts.toLocaleString() : "—"}
              sublabel={range.label}
              accent="warning"
            />
            <StatCard
              label="Sales Closed"
              value={canReadLogs && stats ? stats.sales.toLocaleString() : "—"}
              sublabel={range.label}
              accent="accent"
            />
            <StatCard
              label="Revenue Generated"
              value={canViewRevenue ? formatCurrency(revenue) : "—"}
              sublabel={range.label}
              accent="victory"
            />
          </div>

          {canViewRevenue ? (
            <ArcadePanel title="Revenue · Confirmed Sales">
              <StatCard
                label="Revenue"
                value={formatCurrency(revenue)}
                accent="victory"
                sublabel={`${range.label} · confirmed sales only`}
              />
            </ArcadePanel>
          ) : (
            <ArcadePanel title="Revenue · Confirmed Sales">
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <EyeOff className="w-4 h-4" />
                Revenue is hidden on peer profiles. You see production metrics only.
              </div>
            </ArcadePanel>
          )}

          {canReadLogs && stats ? (
            <>
              <ArcadePanel
                title="Conversion Funnel"
                action={
                  <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                    {range.label}
                  </span>
                }
              >
                {Object.values(stats).every((v) => v === 0) ? (
                  <div className="text-sm text-muted-foreground">
                    No funnel activity in this range yet.
                  </div>
                ) : (
                  <FunnelStageBars
                    stages={funnelStages({
                      doors: stats.doors,
                      talks: stats.contacts,
                      leads: stats.leads,
                      sits: stats.sits,
                      sales: stats.sales,
                    })}
                  />
                )}
              </ArcadePanel>
              <ArcadePanel
                title="At the Door"
                action={
                  <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                    {range.label}
                  </span>
                }
              >
                {pinsQuery.isPending ? (
                  <div className="text-sm text-muted-foreground">Loading pins…</div>
                ) : pinsQuery.isError ? (
                  <div className="text-sm text-muted-foreground">Couldn't load pins for this range.</div>
                ) : (
                  <DoorResultsGrid pins={pinsQuery.data ?? []} />
                )}
              </ArcadePanel>
            </>
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

