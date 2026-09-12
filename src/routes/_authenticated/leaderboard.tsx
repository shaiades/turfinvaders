import { createFileRoute } from "@tanstack/react-router";
import { FleetDispatch } from "@/components/FleetDispatch";
import { CanvasserLeaderboard } from "@/components/CanvasserLeaderboard";
import { useAuth } from "@/hooks/useAuth";
import { isAdminRole } from "@/lib/role-policy";
import { Trophy } from "lucide-react";

export const Route = createFileRoute("/_authenticated/leaderboard")({
  head: () => ({ meta: [{ title: "Leaderboard — Turf Invaders" }] }),
  component: LeaderboardPage,
});

function LeaderboardPage() {
  // Two boards, one address: reps AND captains get the ranked ladder — the
  // race, with their own row glowing (owner call 2026-09-12: the captain's
  // van ops already live on Command, so this tab is their race too) — while
  // the Admin tier keeps the full Fleet Dispatch ops table.
  const { role, loading } = useAuth();
  const leadership = isAdminRole(role);
  return (
    <div className="mx-auto max-w-6xl w-full px-3 py-4 space-y-4">
      <div className="flex items-center gap-2">
        <Trophy className="w-4 h-4 text-neon" />
        <h1 className="font-display text-sm text-neon uppercase tracking-widest">Leaderboard</h1>
      </div>
      <div data-tour="leaders-board">
        {loading ? null : leadership ? <FleetDispatch readOnly /> : <CanvasserLeaderboard />}
      </div>
    </div>
  );
}
