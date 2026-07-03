import { createFileRoute } from "@tanstack/react-router";
import { FieldMode } from "@/components/FieldMode";

export const Route = createFileRoute("/_authenticated/field")({
  head: () => ({ meta: [{ title: "Active Run — Turf Invaders" }] }),
  component: FieldMode,
});
