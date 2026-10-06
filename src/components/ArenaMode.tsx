// §6 Arena Mode — the office-TV view for the weekly meeting. A full-screen,
// landscape-first board that auto-cycles between the live Van Wars standings
// and today's top 3, with the Street Feed running down the side. Read-only,
// large type, sized in vmin so it fills any screen. Manager-gated by the route.

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useVanWars } from "@/hooks/useVanWars";
import { type VanWarStanding } from "@/lib/vanwars";
import { useArcadeLadder, type LadderRow } from "@/hooks/useCanvasserArcade";
import { useFeed } from "@/hooks/useFeed";

const GTA = "'Arial Black', Impact, 'Franklin Gothic Heavy', sans-serif";
const SCENES = 2;
const fmtCash = (n: number) =>
  n >= 10_000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n).toLocaleString()}`;

export function ArenaMode({ onExit }: { onExit: () => void }) {
  const { standings } = useVanWars();
  const day = useArcadeLadder("day");
  const { events } = useFeed(20);
  const [scene, setScene] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setScene((s) => (s + 1) % SCENES), 12_000);
    return () => clearInterval(id);
  }, []);

  const top3 = day.rows.slice(0, 3);

  return (
    <div
      className="fixed inset-0 z-[10030] overflow-hidden"
      style={{
        background:
          "radial-gradient(1400px 700px at 18% -10%, rgba(255,46,154,.16), transparent 60%),radial-gradient(1200px 700px at 92% 112%, rgba(25,227,255,.14), transparent 60%),#06040e",
      }}
    >
      <button
        onClick={onExit}
        className="absolute right-4 top-4 z-10 rounded-lg border border-border bg-surface/70 p-2 text-muted-foreground hover:text-foreground"
        aria-label="Exit Arena"
      >
        <X className="h-5 w-5" />
      </button>

      <div className="flex h-full flex-col p-[3vmin]">
        <div className="text-center">
          <div
            style={{
              fontFamily: GTA,
              fontStyle: "italic",
              fontSize: "6.5vmin",
              lineHeight: 0.9,
              color: "#fff",
              WebkitTextStroke: "0.4vmin #06040e",
              textShadow: "0.5vmin 0.5vmin 0 rgba(255,46,154,.5)",
            }}
          >
            VAN WARS ARENA
          </div>
          <div
            className="font-display uppercase tracking-[0.4em]"
            style={{ fontSize: "1.5vmin", color: "#5cf0ff" }}
          >
            Live · the block is in play
          </div>
        </div>

        <div className="mt-[3vmin] grid min-h-0 flex-1 grid-cols-3 gap-[3vmin]">
          <div
            className="col-span-2 min-h-0 overflow-hidden rounded-[2vmin] border border-border p-[2.5vmin]"
            style={{ background: "rgba(10,8,20,.6)" }}
          >
            {scene === 0 ? <ArenaStandings standings={standings} /> : <ArenaTop3 rows={top3} />}
          </div>

          <div
            className="min-h-0 overflow-hidden rounded-[2vmin] border border-border p-[2vmin]"
            style={{ background: "rgba(10,8,20,.6)" }}
          >
            <div
              className="font-display uppercase tracking-[0.3em]"
              style={{ fontSize: "1.5vmin", color: "#ffd24a" }}
            >
              ★ Street feed
            </div>
            <ul className="mt-[1.5vmin] space-y-[1.1vmin]">
              {events.length === 0 ? (
                <li className="text-white/40" style={{ fontSize: "1.8vmin" }}>
                  Moments stream here live…
                </li>
              ) : (
                events.slice(0, 9).map((e) => (
                  <li key={e.id} className="truncate text-white/90" style={{ fontSize: "1.8vmin" }}>
                    {e.body}
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>

        <div className="mt-[2vmin] flex justify-center gap-2">
          {Array.from({ length: SCENES }).map((_, i) => (
            <span
              key={i}
              className="h-[1vmin] w-[5vmin] rounded-full"
              style={{ background: i === scene ? "#19e3ff" : "rgba(255,255,255,.2)" }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ArenaStandings({ standings }: { standings: VanWarStanding[] }) {
  const leaderWar = standings.length ? Math.max(1e-6, standings[0].war) : 1;
  return (
    <div className="flex h-full flex-col">
      <div
        className="font-display uppercase italic tracking-widest"
        style={{ fontSize: "2.4vmin", color: "#5cf0ff" }}
      >
        Van Wars · this week
      </div>
      <div className="mt-[2vmin] flex flex-1 flex-col justify-around">
        {standings.length < 2 ? (
          <div className="text-white/50" style={{ fontSize: "2.2vmin" }}>
            The race lights up when two crews are on the board.
          </div>
        ) : (
          standings.slice(0, 6).map((v, i) => (
            <div key={v.teamId ?? v.name} className="flex items-center gap-[2vmin]">
              <span
                style={{
                  fontFamily: GTA,
                  fontSize: "3vmin",
                  width: "4vmin",
                  color: i === 0 ? "#ffd24a" : "#8a97b4",
                }}
              >
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-[2vmin]">
                  <span
                    className="truncate"
                    style={{
                      fontFamily: GTA,
                      fontStyle: "italic",
                      fontSize: "3vmin",
                      color: v.color,
                    }}
                  >
                    {v.name}
                  </span>
                  <span style={{ fontFamily: GTA, fontSize: "3vmin", color: v.color }}>
                    {Math.round(v.war)}
                  </span>
                </div>
                <div
                  className="mt-[0.6vmin] overflow-hidden rounded-full"
                  style={{ height: "1.2vmin", background: "rgba(255,255,255,.06)" }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, (v.war / leaderWar) * 100)}%`,
                      height: "100%",
                      background: v.color,
                      boxShadow: `0 0 1.5vmin ${v.color}`,
                    }}
                  />
                </div>
              </div>
              <span
                className="font-display"
                style={{
                  fontSize: "1.8vmin",
                  color: "#9bf00b",
                  width: "9vmin",
                  textAlign: "right",
                }}
              >
                {v.vol > 0 ? fmtCash(v.vol) : "desk"}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ArenaTop3({ rows }: { rows: LadderRow[] }) {
  const order = [rows[1], rows[0], rows[2]].filter(Boolean) as LadderRow[];
  const place = (r: LadderRow) => rows.indexOf(r) + 1;
  const crown: Record<number, string> = { 1: "👑", 2: "🥈", 3: "🥉" };
  const h: Record<number, string> = { 1: "26vmin", 2: "18vmin", 3: "13vmin" };
  return (
    <div className="flex h-full flex-col">
      <div
        className="font-display uppercase italic tracking-widest"
        style={{ fontSize: "2.4vmin", color: "#ffd24a" }}
      >
        Today's top 3
      </div>
      {rows.length === 0 ? (
        <div className="mt-[2vmin] text-white/50" style={{ fontSize: "2.2vmin" }}>
          First knocks of the day take the podium.
        </div>
      ) : (
        <div className="grid flex-1 grid-cols-3 items-end gap-[2vmin] pb-[1vmin]">
          {order.map((r) => {
            const p = place(r);
            return (
              <div key={r.id} className="flex flex-col items-center">
                <span style={{ fontSize: "3vmin" }} aria-hidden>
                  {crown[p]}
                </span>
                <span
                  className="truncate text-center text-white"
                  style={{ fontFamily: GTA, fontSize: "2.4vmin", maxWidth: "100%" }}
                >
                  {r.name.split(" ")[0]}
                </span>
                <span style={{ fontFamily: GTA, fontSize: "2.6vmin", color: "#9bf00b" }}>
                  {r.pts} pts
                </span>
                <div
                  className="mt-[1vmin] w-full rounded-t-[1vmin] border-x border-t border-border"
                  style={{
                    height: h[p],
                    background:
                      "linear-gradient(180deg, rgba(25,227,255,.25), rgba(25,227,255,.04))",
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
