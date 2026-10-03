// "What you're fighting for" — the premium prize flyer (owner 2026-10-03).
// A Steak-48-style poster of the belt ladder, rendered LIVE from the real contest
// rules (so it tracks any prize change in contest_rules). Background:
// Gemini-generated public/close-kombat-feast.jpg. Deliberately NOT the arcade
// skin — this is the aspirational, premium "here's the reward" moment.

import type { KombatRules } from "@/lib/kombat-month";

const SERIF = 'Georgia, Cambria, "Times New Roman", serif';

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

export function KombatPrizeFlyer({ rules }: { rules: KombatRules }) {
  const tiers = [...rules.prizes.tiers].sort((a, b) => a.points - b.points);
  const unlock = rules.prizes.unlock_threshold;
  const mult = rules.prizes.unlock_multiplier;

  return (
    <section
      className="relative overflow-hidden rounded-xl border-2 border-kombat-gold/40 bg-kombat-black"
      style={{
        boxShadow: "0 0 30px -12px color-mix(in oklab, var(--kombat-gold) 55%, transparent)",
      }}
    >
      {/* Premium feast backdrop + top/bottom scrim for legibility. */}
      <img
        src="/close-kombat-feast.jpg"
        alt=""
        aria-hidden
        className="absolute inset-0 z-0 h-full w-full object-cover object-center"
      />
      <span
        aria-hidden
        className="absolute inset-0 z-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(8,6,4,.92) 0%, rgba(8,6,4,.34) 32%, rgba(8,6,4,.46) 58%, rgba(8,6,4,.93) 100%)",
        }}
      />

      <div className="relative z-10 p-5 sm:p-6">
        <div className="font-display text-[9px] uppercase tracking-widest text-kombat-gold">
          Close Kombat · What you're fighting for
        </div>
        <div
          className="mt-1 text-3xl font-black text-kombat-gold sm:text-4xl"
          style={{ fontFamily: SERIF, textShadow: "0 2px 18px rgba(0,0,0,.7)" }}
        >
          The Belt Ladder
        </div>
        <p className="mt-1 text-xs text-white/80">Hit a belt by month end — the cash is yours.</p>

        <ul className="mt-4 space-y-1.5">
          {tiers.map((t) => (
            <li
              key={t.key}
              className="flex items-center justify-between gap-3 rounded-md border border-kombat-gold/25 bg-black/45 px-3 py-2"
            >
              <span
                className="text-base font-bold text-white sm:text-lg"
                style={{ fontFamily: SERIF }}
              >
                {t.label}
              </span>
              <span className="font-bold tabular-nums text-kombat-gold sm:text-lg">
                {t.cash > 0 ? fmtMoney(t.cash) : "Dinner"}
              </span>
            </li>
          ))}
        </ul>

        <p className="mt-3 text-xs text-white/85">
          Crack <span className="font-bold text-kombat-gold">{fmtMoney(unlock)}</span> as a team →
          every cash prize pays <span className="font-bold text-kombat-gold">×{mult}</span>
        </p>
      </div>
    </section>
  );
}
