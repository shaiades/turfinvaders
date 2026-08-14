import { createFileRoute, redirect } from "@tanstack/react-router";

// The Playbook merged into the Mission page's Plan tab (2026-08-14) —
// this stub keeps old bookmarks and PWA shortcuts alive. beforeLoad throws
// before the location commits, so /playbook can stay out of the canvasser
// nav allow-list.
export const Route = createFileRoute("/_authenticated/playbook")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard", search: { tab: "plan" }, replace: true });
  },
});
