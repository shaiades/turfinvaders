import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet, Link, createRootRouteWithContext, useRouter, HeadContent, Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

/** Self-heal stale deploys. Every deploy replaces the hashed /assets chunks,
 *  so a phone that kept the old shell open (the crew runs the PWA all shift)
 *  404s on its next lazy route import — which used to dead-end the whole app
 *  on the "Connection Lost" screen, whose old Retry (router.invalidate) just
 *  re-tried the same dead import (incident 2026-10-06, four deploys in one
 *  day). One hard reload fetches the fresh shell and fixes it; the 60s guard
 *  stops reload loops when the import failed because the network is actually
 *  gone (offline chunk fetches fail the same way). Returns true if a reload
 *  was initiated. */
const RELOAD_GUARD_KEY = "ti_stale_shell_reload_at";
function reloadOnceForStaleShell(): boolean {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY)) || 0;
  } catch {
    /* private mode / blocked storage: still reload, just unguarded-once */
  }
  if (Date.now() - last < 60_000) return false;
  try {
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
  window.location.reload();
  return true;
}

/** Error shapes browsers produce for a failed dynamic chunk/CSS import. */
const STALE_CHUNK_RE =
  /dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError/i;

// Vite dispatches this on window whenever a dynamic-import preload 404s/fails
// (its documented deploy-skew hook). preventDefault() stops the error from
// being thrown into the route tree once the reload is underway.
if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadOnceForStaleShell()) event.preventDefault();
  });
}

import appCss from "../styles.css?url";
// Bundled locally — the unpkg CDN was a single point of failure for the map.
import leafletCss from "leaflet/dist/leaflet.css?url";
import "../lib/fonts";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { registerServiceWorker } from "../lib/register-sw";
import { supabase } from "@/integrations/supabase/client";
import { useTheme } from "@/hooks/useTheme";
import { Toaster } from "sonner";

// Runs before first paint (placed ahead of the stylesheet link in <head>) so
// a user who chose light mode doesn't see a flash of the default dark theme.
const THEME_INIT_SCRIPT =
  "try{if(localStorage.getItem('theme')==='light')document.documentElement.classList.remove('dark')}catch(e){}";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="font-display text-5xl md:text-6xl text-neon">404</h1>
        <h2 className="mt-4 font-display text-base md:text-lg">GAME OVER</h2>
        <p className="mt-2 text-sm text-muted-foreground">This level doesn't exist.</p>
        <div className="mt-6">
          <Link to="/" className="inline-flex items-center rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:opacity-90">
            Respawn at home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error }: { error: Error }) {
  useEffect(() => {
    // A stale-shell chunk error heals itself with one reload — don't flash the
    // dead screen or spend an error report on it (see reloadOnceForStaleShell).
    if (STALE_CHUNK_RE.test(error?.message ?? "") && reloadOnceForStaleShell()) return;
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="font-display text-lg md:text-xl text-[var(--destructive)]">Connection Lost</h1>
        <p className="mt-2 text-sm text-muted-foreground">Something glitched. Try again.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {/* Full reload, not router.invalidate(): after a deploy the old
              shell's chunk URLs are gone, and only a fresh document pulls the
              new ones. For every other error class a reload is at worst
              equivalent. */}
          <button onClick={() => window.location.reload()} className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium">
            Retry
          </button>
          <a href="/" className="rounded-md border border-border px-4 py-2 text-sm">Home</a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      // viewport-fit=cover activates env(safe-area-inset-*) on notched
      // iPhones — required for the pb-safe/pt-safe padding in AppShell,
      // especially in the installed (standalone) home-screen app.
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Turf Invaders" },
      { name: "description", content: "Turf Invaders — the arcade-style canvassing tracker. Claim territory, rack up points, level up your crew." },
      { property: "og:title", content: "Turf Invaders" },
      { name: "twitter:title", content: "Turf Invaders" },
      { property: "og:description", content: "Turf Invaders — the arcade-style canvassing tracker. Claim territory, rack up points, level up your crew." },
      { name: "twitter:description", content: "Turf Invaders — the arcade-style canvassing tracker. Claim territory, rack up points, level up your crew." },
      { property: "og:image", content: "https://turfinvaders.com/turf-invaders-hero.jpg" },
      { name: "twitter:image", content: "https://turfinvaders.com/turf-invaders-hero.jpg" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:type", content: "website" },
      // Installed-PWA chrome: dark status bar + brand tint (canvassers run
      // this from the home screen all shift).
      { name: "theme-color", content: "#16141f" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "apple-mobile-web-app-title", content: "Turf Invaders" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "stylesheet", href: leafletCss },
      // Basemap host: at field-cellular RTTs the DNS+TCP+TLS handshake alone
      // can cost seconds — start it before Leaflet asks for the first tile.
      { rel: "preconnect", href: "https://server.arcgisonline.com", crossOrigin: "anonymous" },
      { rel: "dns-prefetch", href: "https://server.arcgisonline.com" },
      { rel: "icon", type: "image/png", href: "/favicon.png" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/site.webmanifest" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body>{children}<Scripts /></body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();
  const { theme } = useTheme();
  useEffect(() => {
    registerServiceWorker();
  }, []);
  useEffect(() => {
    // supabase-js re-emits SIGNED_IN on tab focus / session recovery, not
    // just at real logins. Re-running every route guard on each focus gave
    // transient network blips a chance to bounce a signed-in user to /auth,
    // so only an actual identity change invalidates (react-query's own
    // refetchOnWindowFocus already keeps data fresh on return). undefined =
    // no identity known yet; the getSession() seed below fills it so the
    // first focus re-emit is deduped too.
    let lastUserId: string | null | undefined;
    supabase.auth.getSession().then(({ data, error }) => {
      if (!error && lastUserId === undefined) lastUserId = data.session?.user.id ?? null;
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      const userId = session?.user.id ?? null;
      const sameIdentity = lastUserId !== undefined && userId === lastUserId;
      lastUserId = userId;
      if (event === "SIGNED_IN" && sameIdentity) return;
      router.invalidate();
      if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
    });
    return () => sub.subscription.unsubscribe();
  }, [router, queryClient]);
  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      {/* top-center + offsets clear the sticky header/HUD — a mid-street
          phone actually sees the toast; richColors makes success/warn/error
          read as themselves instead of one gray chrome. Reward moments get
          the gold reward-toast look via rewardToast() (src/lib/reward-toast). */}
      <Toaster
        theme={theme}
        position="top-center"
        richColors
        offset={{ top: 76 }}
        mobileOffset={{ top: 84 }}
        toastOptions={{ classNames: { toast: "arcade-toast" } }}
      />
    </QueryClientProvider>
  );
}
