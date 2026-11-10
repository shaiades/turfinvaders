import { createFileRoute } from "@tanstack/react-router";

/** The running deployment's commit, for the client's deploy-skew check
 *  (src/lib/deploy-skew.ts). Vercel injects VERCEL_GIT_COMMIT_SHA at build
 *  and runtime; anywhere it's absent (local preview) the endpoint answers
 *  null and the client skips the check rather than ever false-positive
 *  reloading. */
export const Route = createFileRoute("/api/version")({
  server: {
    handlers: {
      GET: async () =>
        new Response(JSON.stringify({ commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null }), {
          headers: {
            "content-type": "application/json",
            // Old clients ask exactly because their own copy is stale —
            // this answer must never come from a cache.
            "cache-control": "no-store",
          },
        }),
    },
  },
});
