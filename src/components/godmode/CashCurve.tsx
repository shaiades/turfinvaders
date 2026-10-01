// The cash curve (God Mode v2, owner 2026-10-01): day-by-day cumulative
// collected $ (victory area) vs anticipated plan (dashed cyan) through the
// month, with a today marker and a scrub readout. Inline SVG, no library.
// All TEXT lives in HTML outside the SVG so scaling never shrinks type.
// Endpoints reconcile with the hero by construction (buildCashCurve).

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { CashCurve as Curve } from "@/lib/collections";

const W = 343;
const H = 150;
const PAD_X = 8;
const BASE_Y = 142;
const TOP_Y = 8;

const fmtShort = (n: number) =>
  n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `$${Math.round(n / 1_000)}K`
      : `$${Math.round(n)}`;
const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

export function CashCurve({ curve, dimmed }: { curve: Curve; dimmed?: boolean }) {
  const [pick, setPick] = useState<number | null>(null);
  const n = curve.days.length;
  const lastColIdx = curve.todayIdx >= 0 ? curve.todayIdx : n - 1;

  const geom = useMemo(() => {
    const yMax = Math.max(curve.antCum[n - 1] ?? 0, curve.colCum[lastColIdx] ?? 0, 1);
    const x = (i: number) => PAD_X + (n <= 1 ? 0 : i * ((W - 2 * PAD_X) / (n - 1)));
    const y = (v: number) => BASE_Y - (v / yMax) * (BASE_Y - TOP_Y);
    const path = (vals: number[], upTo: number) =>
      vals
        .slice(0, upTo + 1)
        .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
        .join(" ");
    const colPath = path(curve.colCum, lastColIdx);
    const area = `${colPath} L${x(lastColIdx).toFixed(1)},${BASE_Y} L${x(0).toFixed(1)},${BASE_Y} Z`;
    // 3 hairline gridlines at clean fractions.
    const grid = [0.25, 0.5, 0.75].map((f) => ({ y: y(yMax * f), v: yMax * f }));
    return { x, y, yMax, colPath, antPath: path(curve.antCum, n - 1), area, grid };
  }, [curve, n, lastColIdx]);

  const onScrub = (clientX: number, el: SVGSVGElement) => {
    const rect = el.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    const step = n <= 1 ? 1 : (W - 2 * PAD_X) / (n - 1);
    setPick(Math.max(0, Math.min(n - 1, Math.round((px - PAD_X) / step))));
  };

  const i = pick ?? lastColIdx;
  const dayLabel = curve.days[i]?.slice(5).replace("-", "/") ?? "";

  return (
    <div className={cn("min-w-0 transition-opacity", dimmed && "opacity-50")}>
      <div className="flex items-center justify-between gap-2 text-[10px]">
        <div className="flex items-center gap-3 text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-victory" /> Collected
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-0 w-3 border-t-2 border-dashed border-turf-cyan" /> Anticipated
          </span>
        </div>
        <span
          className={cn(
            "font-display uppercase tracking-widest tabular-nums",
            curve.delta >= 0 ? "text-victory [text-shadow:none]" : "text-destructive",
          )}
        >
          {curve.delta >= 0 ? "▲" : "▼"} {fmtShort(Math.abs(curve.delta))}{" "}
          {curve.delta >= 0 ? "ahead of" : "behind"} plan
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-1 w-full h-auto touch-none select-none"
        role="img"
        aria-label="Cumulative collected vs anticipated through the month"
        onPointerDown={(e) => onScrub(e.clientX, e.currentTarget)}
        onPointerMove={(e) => {
          if (e.buttons > 0 || e.pointerType === "mouse") onScrub(e.clientX, e.currentTarget);
        }}
        onPointerLeave={() => setPick(null)}
      >
        <defs>
          <linearGradient id="cashcurve-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--victory)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--victory)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {geom.grid.map((g, gi) => (
          <line
            key={gi}
            x1={PAD_X}
            x2={W - PAD_X}
            y1={g.y}
            y2={g.y}
            stroke="var(--border)"
            strokeWidth="1"
          />
        ))}
        <path d={geom.area} fill="url(#cashcurve-fill)" />
        <path
          d={geom.antPath}
          fill="none"
          stroke="var(--turf-cyan)"
          strokeWidth="2"
          strokeDasharray="5 4"
          strokeLinejoin="round"
        />
        <path
          d={geom.colPath}
          fill="none"
          stroke="var(--victory)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          style={{ filter: "drop-shadow(0 0 6px var(--victory))" }}
        />
        {curve.todayIdx >= 0 && (
          <line
            x1={geom.x(curve.todayIdx)}
            x2={geom.x(curve.todayIdx)}
            y1={TOP_Y}
            y2={BASE_Y}
            stroke="var(--border)"
            strokeWidth="1"
          />
        )}
        <circle
          cx={geom.x(lastColIdx)}
          cy={geom.y(curve.colCum[lastColIdx] ?? 0)}
          r="4"
          fill="var(--victory)"
          stroke="var(--surface)"
          strokeWidth="2"
        />
        {pick !== null && (
          <line
            x1={geom.x(pick)}
            x2={geom.x(pick)}
            y1={TOP_Y}
            y2={BASE_Y}
            stroke="color-mix(in oklab, var(--neon) 50%, transparent)"
            strokeWidth="1"
          />
        )}
      </svg>
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground tabular-nums">
        <span>
          {dayLabel} · {fmtMoney(curve.colCum[Math.min(i, lastColIdx)] ?? 0)} banked · plan{" "}
          {fmtMoney(curve.antCum[i] ?? 0)}
        </span>
        <span>{fmtShort(geom.yMax)}</span>
      </div>
      {(curve.undatedPlanned > 0 || curve.undatedCollected > 0) && (
        <p className="mt-0.5 text-[10px] text-muted-foreground/70">
          Includes {fmtShort(Math.max(curve.undatedPlanned, curve.undatedCollected))} with no
          scheduled date (counted at month start).
        </p>
      )}
    </div>
  );
}
