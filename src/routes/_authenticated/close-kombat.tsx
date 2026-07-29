import { createFileRoute } from "@tanstack/react-router";
import { CLOSE_KOMBAT_ROLES, requireRoleBeforeLoad } from "@/lib/roles";
import { CloseKombat } from "@/components/CloseKombat";

export const Route = createFileRoute("/_authenticated/close-kombat")({
  head: () => ({ meta: [{ title: "Close Kombat — Turf Invaders" }] }),
  // Owners, office staff, and the sales reps themselves — captains excluded
  // (owner decision 2026-07-29). block_cards RLS enforces the same list.
  beforeLoad: requireRoleBeforeLoad(CLOSE_KOMBAT_ROLES),
  component: CloseKombat,
});
