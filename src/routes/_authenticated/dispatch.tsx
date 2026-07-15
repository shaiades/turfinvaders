import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/dispatch")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard", search: { tab: "dispatch" } });
  },
});
