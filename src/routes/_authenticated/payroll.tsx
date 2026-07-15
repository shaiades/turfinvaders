import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/payroll")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard", search: { tab: "payroll" } });
  },
});
