import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// Vercel Skew Protection only pins a request to its deployment when the client
// sends the deployment ID — Nitro/TanStack Start isn't one of the auto-wired
// frameworks (Next/SvelteKit/Qwik/Astro/Nuxt), so without this every deploy
// still 404s the previous build's hashed chunks for open shells. Path-scoped
// __vdpl cookies pin the hashed /assets chunks and /_serverFn calls to the
// deployment that served the document; documents themselves stay unpinned so a
// reload (incl. the stale-shell self-heal in __root.tsx) gets the latest build.
const SKEW_COOKIE_PATHS = ["/assets", "/_serverFn"];
// Outlives any shift; the dashboard's Skew Protection max-age still governs
// how long the pinned deployment actually answers.
const SKEW_COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60;

function appendSkewProtectionCookies(request: Request, response: Response): Response {
  if (process.env.VERCEL_SKEW_PROTECTION_ENABLED !== "1") return response;
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
  if (!deploymentId || request.method !== "GET" || !response.ok) return response;
  const dest = request.headers.get("sec-fetch-dest");
  const isDocument = dest
    ? dest === "document"
    : (response.headers.get("content-type") ?? "").includes("text/html");
  if (!isDocument) return response;
  try {
    for (const path of SKEW_COOKIE_PATHS) {
      response.headers.append(
        "set-cookie",
        `__vdpl=${deploymentId}; Path=${path}; Max-Age=${SKEW_COOKIE_MAX_AGE_S}; Secure; HttpOnly; SameSite=Strict`,
      );
    }
  } catch {
    // Immutable headers (passthrough fetch Response) — skip; the self-heal
    // reload in __root.tsx still covers that client.
  }
  return response;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return appendSkewProtectionCookies(request, await normalizeCatastrophicSsrResponse(response));
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
