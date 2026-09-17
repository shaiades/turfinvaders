// Door objections quick-pick (captain feedback 2026-09-17): after marking a
// house "Not Interested", optionally log which objection it was so captains
// can review the next day what reps are hitting most. Plain strings, not a
// DB enum, so the list can grow without a migration.
export const DOOR_OBJECTIONS = [
  "Have a guy",
  "Not interested",
  "No money",
  "Not now",
  "Talk to my spouse",
  "Other",
] as const;

export type DoorObjection = (typeof DOOR_OBJECTIONS)[number];
