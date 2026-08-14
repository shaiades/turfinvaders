// Single source of truth for the Monday.com lead-form URL. Both embed
// surfaces (the Log tab's MondayEmbed and Active Run's LeadSheet) iframe the
// same URL: an admin-saved override in localStorage, else the embed-format
// default. Saved per device.
export const MONDAY_URL_STORAGE_KEY = "knockout.monday_form_url";

export const DEFAULT_MONDAY_FORM_URL =
  "https://forms.monday.com/forms/embed/2e7e2733e186b6e9f3a37c17523f6e6f?r=use1";

export function isSafeUrl(u: string) {
  try {
    const url = new URL(u);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export function getMondayFormUrl(): string {
  if (typeof window === "undefined") return DEFAULT_MONDAY_FORM_URL;
  return localStorage.getItem(MONDAY_URL_STORAGE_KEY) ?? DEFAULT_MONDAY_FORM_URL;
}
