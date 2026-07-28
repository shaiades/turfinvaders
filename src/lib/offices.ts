// The two physical offices. Pure constants — safe to import from client
// components and server-fn files alike. Rows with a NULL office_location
// predate the Orange County launch and are attributed to DEFAULT_OFFICE.
export const OFFICE_LOCATIONS = ["San Diego", "Orange County"] as const;
export type OfficeLocation = (typeof OFFICE_LOCATIONS)[number];

export const DEFAULT_OFFICE: OfficeLocation = "San Diego";

/** Office filter UI vocabulary: the offices plus "All". */
export const OFFICE_FILTER_OPTIONS = ["All", ...OFFICE_LOCATIONS] as const;
export type OfficeFilter = (typeof OFFICE_FILTER_OPTIONS)[number];
