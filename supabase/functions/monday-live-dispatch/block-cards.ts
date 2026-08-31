// Close Kombat snapshot helpers (owner directive 2026-07-29): every
// Block-board card is mirrored into public.block_cards with its closer-side
// column labels stored verbatim (Reps / Iss / BO / OL / RS / PM / Sale +
// Sale Price), so sales-rep stats speak Monday.com's language. Pure module —
// no Deno APIs — so it can be exercised under Node with fixtures.
//
// KEEP IN SYNC: the same row-building rules are duplicated for the Node
// runtime in src/lib/close-kombat.functions.ts (the on-demand backfill
// sync), and SOLD_VALUES is mirrored in src/lib/close-kombat.ts (the UI
// aggregator). The Deno edge function cannot import from src/ and vice
// versa — one copy per runtime, same as the Monday retry helpers.

export type MondayCol = {
  id: string
  text: string | null
  display_value?: string | null
  column: { title: string; id: string }
}

/** Sale-column values that mean the item is sold. */
export const SOLD_VALUES = ['sold', 'reload', 'upsell', 'sale']

/** Trailing "(copy)" / "(copy 2)" marker Monday appends when an item is
 *  duplicated — possibly stacked ("Linda Fitzle & Mr. (copy) (copy)"). */
const COPY_SUFFIX_RE = /(\s*\(copy(\s+\d+)?\))+\s*$/i

/** True when the item name ends in a Monday duplicate marker. */
export function isCopyName(name: unknown): boolean {
  return COPY_SUFFIX_RE.test(String(name ?? ''))
}

/** Item name with every trailing "(copy)"/"(copy N)" marker removed. */
export function stripCopySuffix(name: unknown): string {
  return String(name ?? '').replace(COPY_SUFFIX_RE, '').trim()
}

/** Canonical customer key a card shares with the card it was copied from:
 *  copy markers stripped, case- and whitespace-insensitive. */
export function copyBaseName(name: unknown): string {
  return stripCopySuffix(name).toLowerCase().replace(/\s+/g, ' ')
}

/** Parse Monday money text ("$1,234.56") → number, else null. Rejects
 *  negatives and values beyond the numeric(12,2) range. */
export function parseMoney(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''))
  if (!Number.isFinite(n) || n < 0 || n >= 1e10) return null
  return Math.round(n * 100) / 100
}

/** The "Sale Price" column: exact title first, never the outcome column "Sale". */
export function findSalePriceCol(cols: MondayCol[]): MondayCol | undefined {
  const norm = (s: string | undefined) => (s || '').trim().toLowerCase()
  return (
    cols.find((c) => norm(c.column?.title) === 'sale price') ??
    cols.find((c) => norm(c.column?.title).replace(/\s+/g, '') === 'saleprice') ??
    cols.find((c) => norm(c.column?.title).includes('price'))
  )
}

/** The Sale outcome/status column (title "Sale", never "Sale Price"). */
export function findSaleOutcomeCol(cols: MondayCol[]): MondayCol | undefined {
  const norm = (s: string | undefined) => (s || '').trim().toLowerCase()
  return (
    cols.find((c) => norm(c.column?.title) === 'sale') ??
    cols.find((c) => {
      const t = norm(c.column?.title)
      return t.includes('sale') && !t.includes('price')
    })
  )
}

/** Block boards group cards by weekday; group title → offset from the
 *  board-week Monday. Prefix match ("Monday", "Monday 7/28", …). */
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

/** ISO date of the Monday of the week containing `iso` (UTC-noon math —
 *  mirrors weekStartOfISO in src/lib/dates.ts, which Deno cannot import). */
export function mondayOfISO(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const noon = new Date(Date.UTC(y, m - 1, d, 12))
  const day = noon.getUTCDay() // 0=Sun..6=Sat
  noon.setUTCDate(noon.getUTCDate() + (day === 0 ? -6 : 1 - day))
  return noon.toISOString().slice(0, 10)
}

/**
 * Board name → ISO Monday of its week. "SD Block 7/28/26 - 8/2/26" →
 * "2026-07-28". The FIRST M/D/Y triple wins; tolerates 1-2 digit month/day
 * (manual boards write "8/2/26", the rotation writes "8/02/26") and 2- or
 * 4-digit years; the parsed date is normalized to its Monday in case a
 * hand-made board starts mid-week. Null when nothing parses — callers must
 * decide their own fallback (live events: current LA week; historical
 * sync: skip the board rather than guess).
 */
export function parseBoardWeekStart(boardName: string): string | null {
  const m = String(boardName ?? '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (!m) return null
  const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3])
  const mo = Number(m[1])
  const d = Number(m[2])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return mondayOfISO(`${y}-${pad(mo)}-${pad(d)}`)
}

/** Card's appointment date: board-week Monday + weekday offset from the
 *  group title. Non-weekday groups fall back to `fallbackISO` (live path:
 *  today LA; historical sync: null — never guess history). */
export function deriveCardDate(
  groupTitle: string | null | undefined,
  weekStartISO: string | null,
  fallbackISO: string | null,
): string | null {
  const title = String(groupTitle ?? '').trim().toLowerCase()
  const offset = WEEKDAYS.findIndex((w) => title === w || title.startsWith(w + ' '))
  if (offset < 0 || !weekStartISO) return fallbackISO
  const [y, m, d] = weekStartISO.split('-').map(Number)
  const noon = new Date(Date.UTC(y, m - 1, d, 12))
  noon.setUTCDate(noon.getUTCDate() + offset)
  return noon.toISOString().slice(0, 10)
}

/** True when a copy card's own block day and its counted sibling's block day
 *  are BOTH known and differ — a re-run appointment (Reset Tuesday, ran again
 *  Friday) that must count fresh instead of transitioning the sibling's
 *  outcome away (owner, 2026-08-31: the netting erased 12 RS fleet-wide in
 *  the week of 8/24). Either side unknown → false — the conservative
 *  transition path can never double-count. */
export function isNewAppointmentCopy(
  copyBlockDay: string | null,
  siblingBlockDay: string | null | undefined,
): boolean {
  return copyBlockDay !== null && !!siblingBlockDay && siblingBlockDay !== copyBlockDay
}

/** One row per Monday card — matches public.block_cards, MINUS the two
 *  Sales-Report stamps: `wcc` and `report_reps` are deliberately absent so
 *  the live upsert can never clobber what the Sales-Report pass wrote
 *  (owner, 2026-07-30 for wcc; 2026-08-25 for report_reps). KEEP IN SYNC
 *  with Omit<BlockCard, "wcc" | "report_reps"> in
 *  src/lib/block-cards.server.ts. */
export type BlockCardRow = {
  monday_item_id: string
  board_id: string
  office_location: string
  card_date: string | null
  group_title: string | null
  lead_name: string | null
  reps: string[]
  iss: string | null
  bo: string | null
  ol: string | null
  rs: string | null
  pm: string | null
  sale: string | null
  sale_price: number | null
  products: string | null
  canvass_stats: string | null
  /** Can/Save support (owner, 2026-08-01) — comments carry the "Can/Save"
   *  marker; phone links a save card to the original sale's card. KEEP IN
   *  SYNC with buildBlockCardRow in src/lib/block-cards.server.ts. */
  comments: string | null
  phone: string | null
}

type MondayItemLike = {
  id?: unknown
  name?: unknown
  group?: { id?: unknown; title?: unknown } | null
  column_values?: MondayCol[] | null
}

/** Column label text by exact (trimmed, lowercased) title; empty → null,
 *  mirroring Monday's grey "None" cells. */
function colText(cols: MondayCol[], title: string): string | null {
  const c = cols.find((c) => (c.column?.title || '').trim().toLowerCase() === title)
  const t = (c?.text || '').trim()
  return t === '' ? null : t
}

/**
 * Monday item → block_cards row. Closer-side columns are matched by their
 * board titles (Reps / Iss / BO / OL / RS / PM — plus Products and Canvass
 * Stats for context); Sale and Sale Price reuse the same finders as the
 * canvasser sale sync. The Reps people column's `.text` is Monday's
 * comma-separated display names.
 */
export function buildBlockCardRow(
  item: MondayItemLike,
  boardId: string,
  office: string,
  weekStartISO: string | null,
  fallbackISO: string | null,
): BlockCardRow {
  const cols: MondayCol[] = item.column_values ?? []
  const groupTitle = item.group?.title == null ? null : String(item.group.title)
  const saleCol = findSaleOutcomeCol(cols)
  const saleText = (saleCol?.text || '').trim()
  const priceCol = findSalePriceCol(cols)
  const reps = (colText(cols, 'reps') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    monday_item_id: String(item.id),
    board_id: boardId,
    office_location: office,
    card_date: deriveCardDate(groupTitle, weekStartISO, fallbackISO),
    group_title: groupTitle,
    lead_name: item.name == null ? null : String(item.name),
    reps,
    iss: colText(cols, 'iss'),
    bo: colText(cols, 'bo'),
    ol: colText(cols, 'ol'),
    rs: colText(cols, 'rs'),
    pm: colText(cols, 'pm'),
    sale: saleText === '' ? null : saleText,
    sale_price: parseMoney(priceCol?.text || priceCol?.display_value || ''),
    products: colText(cols, 'products'),
    canvass_stats: colText(cols, 'canvass stats'),
    comments: colText(cols, 'comments'),
    phone: colText(cols, 'phone'),
  }
}
