import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/fleet")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard", search: { tab: "fleet" } });
  },
});
