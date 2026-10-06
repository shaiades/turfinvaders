// ONE "Fighter" card — the canvasser's identity + progression in a single home
// (consolidation 2026-10-05). The selfie→Street-Fighter cartoon, the SCCE pay
// rank and the arcade level sit side by side, with the badges row underneath.
// Replaces the three panels that used to stack on Mission: the old
// MyFighterCard (selfie uploader), the SCCERankBanner (rank + perk + streaks)
// and the "Your Fighter" XP strip (CanvasserProgress). The pay-lock warning
// banner rides along because it's rank-status news the grinder needs up top.
// Cosmetic + identity only; XP never touches pay. The level is LIFETIME XP
// (useWrapData, never month-resets) and badges are PERSISTED trophies
// (useCanvasserBadges) that stay lit once earned and animate the first time.

import { useMemo, useRef } from "react";
import { Camera } from "lucide-react";
import { PAY_LOCK_MIN_ROLLING_AVG } from "@/lib/pay";
import { BADGES, type BadgeId } from "@/lib/canvasserPay";
import { ArcadePanel, ArcadeSkeleton } from "@/components/arcade";
import { BadgeUnlock } from "@/components/BadgeUnlock";
import { RepAvatar } from "@/components/RepAvatar";
import { RankPill, RANK_PERKS } from "@/components/RankPill";
import { useCanvasserProfile } from "@/hooks/useCanvasserProfile";
import { useRepCartoons, cartoonFor } from "@/hooks/useRepCartoons";
import { useMyFighterUpload } from "@/hooks/useMyFighterUpload";
import { useWrapData } from "@/hooks/useWrapData";
import { useCanvasserBadges } from "@/hooks/useCanvasserBadges";

/** Pay-lock states → banner copy (config-dict twin of PayrollLedger's
 *  PAY_LOCK_META; "active" renders nothing). Moved here from CanvasserMission
 *  with the SCCE rank content. */
const PAY_LOCK_BANNERS: Record<
  string,
  { border: string; title: string; titleClass: string; body: string }
> = {
  warned: {
    border: "border-warning/50 bg-warning/10",
    title: "⚠ Pay Lock Warning",
    titleClass: "text-warning",
    body: ` — your rolling 4-week sit average is below ${PAY_LOCK_MIN_ROLLING_AVG}. A second violation within 90 days reverts your comp to the weekly tier reset (rank retained).`,
  },
  reverted: {
    border: "border-destructive/50 bg-destructive/10",
    title: "Pay Lock Reverted",
    titleClass: "text-destructive",
    body: " — you're currently paid on the weekly point tiers. Reinstatement: 3 consecutive weeks at 7+ sits.",
  },
};

export function FighterCard({
  userId,
  displayName,
}: {
  userId: string;
  displayName: string | null;
}) {
  const profile = useCanvasserProfile(userId);
  const wrap = useWrapData("month"); // lifetime level + the live-earned badge set
  const cartoons = useRepCartoons().data;
  const fileRef = useRef<HTMLInputElement>(null);
  const { onPick, busy } = useMyFighterUpload();

  // Live-earned set this month → persisted trophies (stay lit once earned) +
  // the one-time unlock animation for anything freshly earned.
  const liveEarned = useMemo(
    () => new Set<BadgeId>(wrap.badges.filter((b) => b.unlocked).map((b) => b.def.id)),
    [wrap.badges],
  );
  const badges = useCanvasserBadges(userId, liveEarned, !wrap.loading);

  const name = displayName ?? "You";
  const mine = cartoonFor(cartoons, displayName);
  const hasFighter = !!mine?.portrait || !!mine?.full;
  const rank = profile.data?.current_rank ?? "Jr. Silver";
  const banner = PAY_LOCK_BANNERS[profile.data?.pay_lock_status ?? "active"];
  const badgesLoading = wrap.loading || badges.loading;

  return (
    <>
      {banner && (
        <div className={`rounded-xl border p-4 text-xs ${banner.border}`}>
          <span className={`font-display uppercase tracking-widest ${banner.titleClass}`}>
            {banner.title}
          </span>
          <span className="text-muted-foreground">{banner.body}</span>
        </div>
      )}

      <ArcadePanel title="Your Fighter" faction="kombat">
        {/* Identity: avatar (tap to upload) · name · SCCE rank + arcade level side by side */}
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            aria-label={hasFighter ? "Change my fighter photo" : "Upload my fighter photo"}
            className="relative shrink-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-neon disabled:opacity-60"
          >
            <RepAvatar
              name={name}
              cartoon={mine}
              variant="full"
              rounded="lg"
              ring
              className="h-20 w-20"
              textClassName="text-xl"
            />
            <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-surface">
              <Camera className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              void onPick(e.target.files?.[0]);
              e.target.value = "";
            }}
          />

          <div className="min-w-0 flex-1">
            <div className="truncate font-display text-sm uppercase tracking-widest text-foreground">
              {name}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <RankPill rank={rank} size="md" tappable />
              <span className="inline-flex items-center gap-1 rounded border border-[var(--kombat-gold)]/50 bg-[color-mix(in_oklab,var(--kombat-gold)_12%,transparent)] px-2 py-0.5 font-display text-[11px] uppercase tracking-widest text-[var(--kombat-gold)]">
                Lvl {wrap.level.level} · {wrap.level.title}
              </span>
            </div>
            {wrap.loading ? (
              <ArcadeSkeleton className="mt-2 h-2.5 w-full" />
            ) : (
              <div className="mt-2">
                <div className="h-2.5 w-full overflow-hidden rounded-full border border-border bg-foreground/5">
                  <div
                    className="h-full rounded-full bg-neon transition-[width] duration-700 ease-out"
                    style={{ width: `${wrap.level.pct * 100}%`, boxShadow: "0 0 10px var(--neon)" }}
                  />
                </div>
                <div className="mt-1 text-right font-display text-[9px] uppercase tracking-widest tabular-nums text-muted-foreground">
                  {wrap.level.intoLevel}/{wrap.level.levelSpan} XP
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Badges row — persisted trophies: once earned, lit forever */}
        <div className="mt-4">
          <p className="mb-1.5 font-display text-[9px] uppercase tracking-widest text-muted-foreground">
            Badges · {badges.earned.size}/{BADGES.length}
          </p>
          {badgesLoading ? (
            <ArcadeSkeleton className="h-8 w-full" />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {BADGES.map((def) => {
                const unlocked = badges.earned.has(def.id);
                return (
                  <span
                    key={def.id}
                    title={`${def.label} — ${def.blurb}`}
                    className={`flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] ${
                      unlocked
                        ? "border-[var(--kombat-gold)]/60 text-foreground"
                        : "border-border text-muted-foreground/40"
                    }`}
                  >
                    <span aria-hidden className={unlocked ? "" : "opacity-40 grayscale"}>
                      {def.icon}
                    </span>
                    {def.label}
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {/* SCCE rank context: perk + rank-progression streaks */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            SCCE Rank · <span className="text-foreground">{RANK_PERKS[rank] ?? ""}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            <span>
              3+ sits wks ·{" "}
              <span className="text-neon">{profile.data?.consecutive_weeks_3_plus_sits ?? 0}</span>
            </span>
            <span>
              7+ sits wks ·{" "}
              <span className="text-victory">
                {profile.data?.consecutive_weeks_7_plus_sits ?? 0}
              </span>
            </span>
            <span>
              4-wk avg ·{" "}
              <span className="text-accent">
                {(profile.data?.rolling_4_week_sit_avg ?? 0).toFixed(1)}
              </span>
            </span>
            <span>
              recruits ·{" "}
              <span className="text-foreground">{profile.data?.recruits_count ?? 0}</span>
            </span>
          </div>
        </div>

        <p className="mt-3 text-[11px] text-muted-foreground">
          {busy
            ? "Drawing your fighter… this takes a few seconds."
            : hasFighter
              ? "Tap your avatar to upload a new photo and redraw your fighter."
              : "Tap your avatar to upload a selfie — we'll draw you as a fighter and show it next to your name everywhere."}
        </p>
      </ArcadePanel>

      {/* First-time unlock animation — plays once, then markSeen persists it. */}
      {badges.unseen.length > 0 && (
        <BadgeUnlock badges={badges.unseen} onDone={(ids) => badges.markSeen(ids)} />
      )}
    </>
  );
}
