import { createFileRoute } from "@tanstack/react-router";
import { LiveDispatch } from "@/components/LiveDispatch";
import { Trophy } from "lucide-react";

export const Route = createFileRoute("/_authenticated/leaderboard")({
  head: () => ({ meta: [{ title: "Leaderboard — Turf Invaders" }] }),
  component: LeaderboardPage,
});

function LeaderboardPage() {
  return (
    <div className="mx-auto max-w-6xl w-full px-3 py-4 space-y-4">
      <div className="flex items-center gap-2">
        <Trophy className="w-4 h-4 text-neon" />
        <h1 className="font-display text-sm text-neon uppercase tracking-widest">
          Leaderboard
        </h1>
      </div>
      <LiveDispatch readOnly />
    </div>
  );
}
