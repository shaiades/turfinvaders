import { createFileRoute } from "@tanstack/react-router";
import { FleetDispatch } from "@/components/FleetDispatch";
import { CanvasserLeaderboard } from "@/components/CanvasserLeaderboard";
import { useAuth } from "@/hooks/useAuth";
import { isManagerRole } from "@/lib/role-policy";
import { Trophy } from "lucide-react";

export const Route = createFileRoute("/_authenticated/leaderboard")({
  head: () => ({ meta: [{ title: "Leaderboard — Turf Invaders" }] }),
  component: LeaderboardPage,
});

function LeaderboardPage() {
  // Two boards, one address (audit P1-4, owner: full rebuild): reps get a
  // ranked ladder — the race, with their own row glowing — while leadership
  // keeps the full Fleet Dispatch ops table it actually manages from.
  const { role, loading } = useAuth();
  const leadership = isManagerRole(role);
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
