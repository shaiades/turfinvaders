// §10 entry states: the premium landing card (not started) and the resume
// card (in progress). Both live on /my-purpose; the workshop itself is
// /my-purpose/workshop.

import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Compass } from "lucide-react";
import { LANDING_COPY, EMPTY_STATE_COPY, MODULES } from "@/data/purpose-workshop-content";
import { useEnsurePurposeProfile } from "@/hooks/usePurposeProfile";
import type { PurposeProfileRow } from "@/hooks/usePurposeTable";
import { PurposeButton, PurposeCard, PurposeLabel } from "./kit";

export function PurposeLanding({ userId }: { userId: string }) {
  const navigate = useNavigate();
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ensure = useEnsurePurposeProfile(userId);

  return (
    <div className="purpose-surface min-h-dvh">
      <div className="mx-auto w-full max-w-xl px-4 pt-safe pb-16">
        <div className="flex items-center gap-2 pt-8">
          <Compass className="size-5 text-[var(--purpose-tide)]" aria-hidden />
          <PurposeLabel>My Purpose</PurposeLabel>
        </div>
        <p className="mt-1 text-sm text-[var(--purpose-sand)]">{LANDING_COPY.subtitle}</p>

        <PurposeCard className="mt-6">
          <h1 className="text-2xl leading-snug md:text-3xl">{LANDING_COPY.headline}</h1>
          <p className="mt-4 text-base leading-relaxed text-[var(--purpose-ink-dim)]">
            {LANDING_COPY.body}
          </p>
          <ul className="mt-6 space-y-2.5">
            {LANDING_COPY.commitments.map((c) => (
              <li key={c} className="flex items-start gap-2.5 text-sm leading-relaxed">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[var(--purpose-tide)]" aria-hidden />
                {c}
              </li>
            ))}
          </ul>

          <label className="mt-7 flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              className="mt-1 size-5 accent-[var(--purpose-tide)]"
            />
            <span className="text-sm leading-relaxed">{LANDING_COPY.ackText}</span>
          </label>

          {error && (
            <div className="mt-4 rounded-xl border border-[var(--purpose-sand)] p-3.5 text-sm">{error}</div>
          )}

          <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <PurposeButton
              disabled={!ack || ensure.isPending}
              onClick={() => {
                setError(null);
                ensure
                  .mutateAsync()
                  .then(() => navigate({ to: "/my-purpose/workshop" }))
                  .catch((e: unknown) =>
                    setError(e instanceof Error ? e.message : "Could not start right now."),
                  );
              }}
              className="sm:min-w-52"
            >
              {LANDING_COPY.primaryCta}
            </PurposeButton>
            <PurposeButton
              tone="quiet"
              onClick={() => {
                // A deep link has no history to go back to — home covers both.
                if (window.history.length > 1) window.history.back();
                else void navigate({ to: "/" });
              }}
            >
              {LANDING_COPY.secondaryCta}
            </PurposeButton>
          </div>
        </PurposeCard>

        <p className="mt-6 text-center text-xs leading-relaxed text-[var(--purpose-ink-dim)]">
          {EMPTY_STATE_COPY.not_started}
        </p>
      </div>
    </div>
  );
}

export function PurposeResumeCard({ profile, pct }: { profile: PurposeProfileRow; pct: number | null }) {
  const navigate = useNavigate();
  const moduleMeta =
    MODULES.find((m) => `module_${m.index}` === profile.current_module) ?? MODULES[0];
  return (
    <div className="purpose-surface min-h-dvh">
      <div className="mx-auto w-full max-w-xl px-4 pt-safe pb-16">
        <PurposeCard className="mt-12 text-center">
          <PurposeLabel className="justify-center">My Purpose</PurposeLabel>
          <h1 className="mt-3 text-2xl leading-snug">{LANDING_COPY.resumeHeadline}</h1>
          <p className="mt-3 text-sm leading-relaxed text-[var(--purpose-ink-dim)]">
            {EMPTY_STATE_COPY.in_progress}
          </p>
          <p className="mt-5 text-sm">
            Part {moduleMeta.index} of {MODULES.length} — {moduleMeta.label}
            {pct != null && (
              <span className="ml-2 tabular-nums text-[var(--purpose-ink-dim)]">· {pct}% done</span>
            )}
          </p>
          <div className="mt-7">
            <PurposeButton onClick={() => void navigate({ to: "/my-purpose/workshop" })} className="min-w-56">
              {LANDING_COPY.resumeCta}
            </PurposeButton>
          </div>
        </PurposeCard>
      </div>
    </div>
  );
}
