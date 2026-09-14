import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArcadeCard } from "@/components/arcade";
import {
  DEFAULT_MONDAY_FORM_URL,
  getMondayFormUrl,
  LEAD_SUBMITTED_MESSAGE_TYPE,
} from "@/lib/monday-form";

export const Route = createFileRoute("/lead-submitted")({
  head: () => ({ meta: [{ title: "Lead Received — Turf Invaders" }] }),
  component: LeadSubmittedPage,
});

/**
 * Post-submit redirect target for the app-only Monday lead form. It loads
 * INSIDE ActiveRun's LeadSheet iframe, so it must stay a public top-level
 * route — an _authenticated bounce to /auth here would eat the signal.
 * postMessage tells the parent app the submit landed (same-origin target;
 * the LeadSheet listener checks origin + type, so a non-app parent gets
 * nothing). Opened standalone — a full-tab form, the office shortlink —
 * it is just a friendly confirmation screen.
 */
function LeadSubmittedPage() {
  // Form URL read after mount: this route SSRs and a render-time
  // localStorage read is a hydration mismatch (piggy_demo precedent).
  const [formUrl, setFormUrl] = useState(DEFAULT_MONDAY_FORM_URL);
  // "Submit another lead" is a standalone-only affordance: inside the
  // LeadSheet iframe a second in-iframe submission would land with no pin
  // and no close signal — in-app, the next lead starts from ⚡ on the map.
  const [standalone, setStandalone] = useState(false);
  useEffect(() => {
    setFormUrl(getMondayFormUrl());
    try {
      setStandalone(window.self === window.top);
    } catch {
      /* cross-origin parent — definitely iframed */
    }
    try {
      window.parent?.postMessage({ type: LEAD_SUBMITTED_MESSAGE_TYPE }, window.location.origin);
    } catch {
      /* not iframed — the confirmation screen below still lands */
    }
  }, []);
  return (
    <div className="min-h-dvh flex items-center justify-center px-4 py-8 bg-background">
      <ArcadeCard glow className="max-w-sm w-full text-center space-y-3 p-6">
        <div className="text-4xl" aria-hidden>
          ⚡
        </div>
        <h1 className="font-display text-sm uppercase tracking-widest text-neon">Lead received</h1>
        <p className="text-sm text-muted-foreground">
          It&apos;s on the board. Head back to the map — the next door is waiting.
        </p>
        {standalone && (
          <a className="text-xs underline text-muted-foreground" href={formUrl}>
            Submit another lead
          </a>
        )}
      </ArcadeCard>
    </div>
  );
}
