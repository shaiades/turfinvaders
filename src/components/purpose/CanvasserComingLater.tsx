// §8.3 / §23 — a canvasser (or captain) who deep-links into My Purpose gets a
// friendly message, never a silent bounce. The AppShell cages deliberately
// allow /my-purpose through so this card can render.

import { Compass } from "lucide-react";
import { ERROR_COPY } from "@/data/purpose-workshop-content";
import { PurposeCard, PurposeLabel } from "./kit";

export function CanvasserComingLater({
  unauthorized,
  notReady,
}: {
  unauthorized?: boolean;
  notReady?: boolean;
}) {
  return (
    <div className="purpose-surface min-h-dvh">
      <div className="mx-auto w-full max-w-xl px-4 pt-safe">
        <PurposeCard className="mt-16 text-center">
          <Compass className="mx-auto size-8 text-[var(--purpose-tide)]" aria-hidden />
          <PurposeLabel className="mt-3 justify-center">My Purpose</PurposeLabel>
          <p className="mt-4 text-base leading-relaxed">
            {notReady
              ? "My Purpose isn't unlocked yet — its database migration hasn't been applied."
              : unauthorized
                ? ERROR_COPY.unauthorized
                : ERROR_COPY.canvasser}
          </p>
          <button
            type="button"
            onClick={() => window.history.back()}
            className="mt-7 text-sm text-[var(--purpose-tide)] hover:underline"
          >
            Back to my day
          </button>
        </PurposeCard>
      </div>
    </div>
  );
}
