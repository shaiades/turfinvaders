// The daily "remember your why" — a calm full-screen card shown once per LA
// day after the rep's door-kick intro, ONLY once their Purpose Profile is
// submitted (an unfinished workshop must never be nagged). Clones the
// CloseKombatIntro stamp protocol exactly: localStorage ISO + isLaToday, auth
// user_metadata as the cross-device backstop (1.2s race), stamp at display
// START so a crash can't loop it, `?purpose_reminder=1` previews without
// stamping. This is a static card, not an animation — reduced motion just
// loses the fade, the reminder itself still shows.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Compass } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { isLaToday } from "@/lib/dates";
import { pickReminderLine } from "@/data/purpose-workshop-content";
import { QK } from "@/lib/purpose/questionKeys";
import { usePurposeConfig } from "@/hooks/usePurposeConfig";
import { usePurposeProfile } from "@/hooks/usePurposeProfile";
import { usePurposeAnswers } from "@/hooks/usePurposeAnswers";
import { PurposeButton, PurposeLabel } from "./kit";

const seenKey = (uid: string) => `ti_purpose_reminder_v1:${uid}`;

type ReminderMeta = { ti_purpose_reminder?: string };

export function isPurposeReminderForced(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("purpose_reminder") === "1";
}

function readLocal(key: string): boolean {
  try {
    return isLaToday(window.localStorage.getItem(key));
  } catch {
    return true; // can't persist "seen" → never loop the card
  }
}

function writeLocal(key: string) {
  try {
    window.localStorage.setItem(key, new Date().toISOString());
  } catch {
    /* private mode — the metadata write still covers us */
  }
}

export function PurposeReminderCard({
  userId,
  heldBack,
  onActiveChange,
}: {
  userId: string;
  heldBack?: boolean;
  onActiveChange?: (active: boolean) => void;
}) {
  const forced = isPurposeReminderForced();
  const [phase, setPhase] = useState<"checking" | "ready" | "showing" | "done">(() => {
    if (typeof window === "undefined") return "done";
    if (forced) return "ready";
    return readLocal(seenKey(userId)) ? "done" : "checking";
  });
  const stampedRef = useRef(false);

  const configQuery = usePurposeConfig(phase !== "done");
  const profileQuery = usePurposeProfile(phase !== "done" ? userId : undefined);
  const profile = profileQuery.data?.row ?? null;
  const answersQuery = usePurposeAnswers(
    phase !== "done" && profile?.status === "submitted" ? profile.id : undefined,
  );

  // The card holds the page tours while visible (same contract as the intro).
  useEffect(() => {
    onActiveChange?.(phase === "showing");
    return () => onActiveChange?.(false);
  }, [phase, onActiveChange]);

  // Cross-device backstop: a stamp from TODAY on any device suppresses.
  useEffect(() => {
    if (phase !== "checking") return;
    let cancelled = false;
    (async () => {
      const meta = await Promise.race([
        supabase.auth
          .getSession()
          .then(({ data }) => (data.session?.user?.user_metadata ?? {}) as ReminderMeta),
        new Promise<ReminderMeta>((resolve) => window.setTimeout(() => resolve({}), 1200)),
      ]).catch(() => ({}) as ReminderMeta);
      if (cancelled) return;
      if (isLaToday(meta.ti_purpose_reminder)) {
        writeLocal(seenKey(userId));
        setPhase("done");
      } else {
        setPhase("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, userId]);

  // Eligibility + sequencing: show once the intro releases us AND the data
  // is real. Not submitted / flag off / no profile → render nothing, stamp
  // nothing (the reminder earns its slot only after the workshop is done).
  //
  // Settle ORDER matters: answersQuery is a dependent query (it only enables
  // after the profile row arrives), so "config and profile settled" is NOT
  // "everything settled" — deciding 'done' there would cancel the card on
  // every cold open while the five-table answers fetch is still in flight.
  // Each query gets its own definitive verdict; loading always means WAIT.
  useEffect(() => {
    if (phase !== "ready" || heldBack) return;

    if (!forced) {
      // Config: null = missing migration (treat as feature-off), false = off.
      if (configQuery.isLoading) return;
      if (configQuery.isError || configQuery.data == null || !configQuery.data.sales_rep_feature_enabled) {
        setPhase("done");
        return;
      }
      // Profile: must exist and be submitted.
      if (profileQuery.isLoading) return;
      const p = profileQuery.data?.row ?? null;
      if (profileQuery.isError || !p || p.status !== "submitted") {
        setPhase("done");
        return;
      }
      // Answers: the card is the rep's own words — wait for them.
      if (answersQuery.isError) {
        setPhase("done");
        return;
      }
      if (!answersQuery.data) return;
    }

    if (!stampedRef.current) {
      stampedRef.current = true;
      if (!forced) {
        writeLocal(seenKey(userId));
        const patch: ReminderMeta = { ti_purpose_reminder: new Date().toISOString() };
        supabase.auth.updateUser({ data: patch }).catch(() => {});
      }
    }
    setPhase("showing");
  }, [
    phase,
    heldBack,
    forced,
    userId,
    configQuery.isLoading,
    configQuery.isError,
    configQuery.data,
    profileQuery.isLoading,
    profileQuery.isError,
    profileQuery.data,
    answersQuery.isError,
    answersQuery.data,
  ]);

  const dismiss = useCallback(() => setPhase("done"), []);

  if (phase !== "showing") return null;

  const answers = answersQuery.data ?? {};
  const coreWhy = answers[QK.why_7]?.text ?? "";
  const target = answers[QK.m4_one_year_target]?.text ?? "";
  const targetDate = ((answers[QK.m4_evidence]?.json ?? {}) as { date?: string }).date ?? "";

  return (
    <div
      className="purpose-surface fixed inset-0 z-[9998] flex items-center justify-center overflow-y-auto px-5 py-10 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500"
      role="dialog"
      aria-label="My Purpose reminder"
    >
      <div className="w-full max-w-md text-center">
        <Compass className="mx-auto size-7 text-[var(--purpose-tide)]" aria-hidden />
        <PurposeLabel className="mt-3 justify-center">My Purpose</PurposeLabel>
        {coreWhy ? (
          <p className="mt-6 text-2xl leading-snug">{coreWhy}</p>
        ) : (
          <p className="mt-6 text-2xl leading-snug text-[var(--purpose-ink-dim)]">
            Your reason lives here once you finish My Purpose.
          </p>
        )}
        {target && (
          <p className="mt-5 text-sm text-[var(--purpose-ink-dim)]">
            {target}
            {targetDate ? ` · by ${targetDate}` : ""}
          </p>
        )}
        <p className="mt-6 text-sm italic leading-relaxed text-[var(--purpose-sand)]">
          {pickReminderLine(answers)}
        </p>
        <div className="mt-9 flex flex-col items-center gap-4">
          <PurposeButton onClick={dismiss} className="min-w-44">
            Let's work
          </PurposeButton>
          <Link
            to="/my-purpose"
            onClick={dismiss}
            className="text-sm text-[var(--purpose-ink-dim)] hover:text-[var(--purpose-ink)]"
          >
            Open My Purpose
          </Link>
        </div>
      </div>
    </div>
  );
}
