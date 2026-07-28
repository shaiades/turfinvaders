import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(n: number) {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/** trim → lowercase → collapse internal whitespace; "" for null/undefined.
 *  The client-side twin of the edge function's normalizeName — canvasser
 *  names are matched across Monday and profiles with exactly this rule. */
export function normalizeName(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** getCurrentPosition as a promise; resolves null on error/unsupported/SSR. */
export function getPositionOrNull(options?: PositionOptions): Promise<GeolocationPosition | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(p),
      () => resolve(null),
      options,
    );
  });
}
