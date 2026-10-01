/** Shared CSV building for every export surface (payroll ledger, Reports
 *  console). One escaping implementation so quoting and the injection guard
 *  can't drift between exports. */

/** Escape one cell. Beyond RFC-4180 quoting, cells that would execute as a
 *  spreadsheet formula (=, +, -, @, tab/CR starts) get a leading apostrophe —
 *  these files open straight in Excel/Sheets at an accounting desk, and a
 *  display_name is user-controlled text. */
export function csvCell(v: unknown): string {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Trigger a client-side download of the joined lines. */
export function downloadCsvFile(filename: string, lines: string[]): void {
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
