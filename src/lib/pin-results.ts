// Knock-result vocabulary shared by every pin consumer (map, picker, Stats,
// manager timeline). Lives in lib — NOT in NeonMap — so leaflet never enters
// the SSR module graph of pages that only need labels/colors.

export type PinType =
  | "not_home"
  | "talked_to"
  | "lead"
  | "knock"
  | "not_interested"
  | "renter"
  | "appt"
  | "go_back";

// One color per knock result (matches the canvasser result picker); leads
// keep their own star on the map.
export const PIN_COLORS: Record<PinType, string> = {
  not_home: "#ff2d55",
  knock: "#00e5ff",
  talked_to: "#ffd60a",
  not_interested: "#ff6b00",
  renter: "#c77dff",
  go_back: "#00e5ff",
  appt: "#ffd60a",
  lead: "#39ff14",
};

export const PIN_LABELS: Record<PinType, string> = {
  not_home: "NOT HOME",
  knock: "KNOCK",
  talked_to: "TALKED TO",
  not_interested: "NOT INTERESTED",
  renter: "RENTER",
  go_back: "GO BACK",
  appt: "APPT SET",
  lead: "LEAD GENERATED",
};
