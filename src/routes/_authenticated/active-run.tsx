import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/active-run")({
  beforeLoad: () => {
    throw redirect({ to: "/field" });
  },
});
