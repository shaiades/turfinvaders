import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Phone } from "lucide-react";
import { ArcadeCard } from "@/components/arcade";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/called/$token")({
  head: () => ({ meta: [{ title: "No-Show Callback — Turf Invaders" }] }),
  component: CallbackPage,
});

/**
 * The confirmer's one-tap no-show callback page (owner, 2026-11-23).
 * Opened from the SMS the Monday Twilio automation sends Cynthia / Jeni when
 * a Block card flips to "No Show". PUBLIC top-level route on purpose
 * (lead-submitted precedent) — the confirmation desk opens it from a text,
 * not from an app session; the 128-bit token in the path is the auth.
 * One customer, one button: "I called them" → /api/callback POST stamps
 * who/when and pages Tyler + Shai. Repeat taps are read-backs, never
 * double-pings.
 */

type CallbackInfo = {
  leadName: string | null;
  customerPhone: string | null;
  address: string | null;
  apptTime: string | null;
  cardDate: string | null;
  office: string | null;
  confirmerName: string;
  calledAt: string | null;
  siblingCalled: { name: string; at: string } | null;
  error?: string;
};

function fmtWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function CallbackPage() {
  const { token } = Route.useParams();
  const [info, setInfo] = useState<CallbackInfo | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "sending" | "done" | "bad">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/callback?t=${encodeURIComponent(token)}`);
        const body = (await res.json()) as CallbackInfo;
        if (cancelled) return;
        if (!res.ok) {
          setState("bad");
          return;
        }
        setInfo(body);
        setState(body.calledAt ? "done" : "ready");
      } catch {
        if (!cancelled) setState("bad");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const markCalled = useCallback(async () => {
    setState("sending");
    try {
      const res = await fetch("/api/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await res.json()) as CallbackInfo & { ok?: boolean };
      if (!res.ok || !body.ok) {
        setState("ready");
        return;
      }
      setInfo(body);
      setState("done");
    } catch {
      setState("ready");
    }
  }, [token]);

  const telHref = info?.customerPhone ? `tel:${info.customerPhone.replace(/[^\d+]/g, "")}` : null;

  return (
    <div className="min-h-dvh flex items-center justify-center px-4 py-8 bg-background">
      <ArcadeCard glow className="max-w-sm w-full space-y-4 p-6">
        {state === "loading" && (
          <p className="text-sm text-muted-foreground text-center">Loading…</p>
        )}

        {state === "bad" && (
          <>
            <h1 className="font-display text-sm uppercase tracking-widest text-destructive text-center">
              Link not recognized
            </h1>
            <p className="text-sm text-muted-foreground text-center">
              This callback link isn&apos;t valid. Open the newest no-show text, or ask the office
              to resend it.
            </p>
          </>
        )}

        {info && state !== "bad" && state !== "loading" && (
          <>
            <div className="text-center space-y-1">
              <div className="text-3xl" aria-hidden>
                📞
              </div>
              <h1 className="font-display text-sm uppercase tracking-widest text-neon">
                No-show callback
              </h1>
              <p className="text-xs text-muted-foreground">
                Hi {info.confirmerName} — this one didn&apos;t answer the door.
              </p>
            </div>

            <div className="rounded-md border border-border/60 bg-background/40 p-3 space-y-1.5 text-sm">
              <div className="font-medium text-base">{info.leadName ?? "Unknown customer"}</div>
              {info.customerPhone && telHref && (
                <a
                  href={telHref}
                  className="flex items-center gap-2 text-neon underline underline-offset-2 min-h-11"
                >
                  <Phone className="h-4 w-4 shrink-0" aria-hidden />
                  {info.customerPhone}
                </a>
              )}
              {info.address && <div className="text-muted-foreground">{info.address}</div>}
              {(info.apptTime || info.cardDate) && (
                <div className="text-muted-foreground">Appt: {info.apptTime ?? info.cardDate}</div>
              )}
              {info.office && <div className="text-xs text-muted-foreground/80">{info.office}</div>}
            </div>

            {info.siblingCalled && state !== "done" && (
              <p className="text-xs text-amber-500 text-center">
                Heads up: {info.siblingCalled.name} already marked this one called at{" "}
                {fmtWhen(info.siblingCalled.at)}.
              </p>
            )}

            {state === "done" ? (
              <div className="text-center space-y-1">
                <p className="text-sm font-medium text-neon">
                  ✅ Logged{info.calledAt ? ` at ${fmtWhen(info.calledAt)}` : ""}.
                </p>
                <p className="text-xs text-muted-foreground">
                  Tyler and Shai have been notified. You&apos;re done here.
                </p>
              </div>
            ) : (
              <Button
                className="w-full h-12 text-base"
                disabled={state === "sending"}
                onClick={markCalled}
              >
                {state === "sending" ? "Logging…" : "I called them"}
              </Button>
            )}
          </>
        )}
      </ArcadeCard>
    </div>
  );
}
