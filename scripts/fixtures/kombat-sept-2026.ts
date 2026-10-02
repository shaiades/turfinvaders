// September 2026 Sales Report calibration fixture (owner's test, Kombat
// Month spec §6). Transcribed 2026-10-02 from the live boards — SD
// 18429184484 (72 rows) + OC 18429184562 (16 rows) — via the Monday API:
// Sale Amt (numbers4), Sales Count (status21), Source (color_mktazp4s),
// Marketing Home (status4), Advantage+ (color_mkwkv9tg), WCC (specs),
// Sales Rep (people). Customer names are omitted (not scoring inputs).
// Row shape: [sale_amt, sales_count, source, marketing_home, advantage_plus,
// wcc, reps]. null = the cell was blank on the board.

export type SeptRow = [
  amt: number,
  count: string | null,
  source: string | null,
  mh: string | null,
  ap: string | null,
  wcc: string | null,
  reps: string[],
];

const Y = "Yakup Sancakli";
const JX = "Jaxon Heilman";
const G = "Garett Koltun";
const JH = "Josiah Haas";
const BL = "Bergan Lundak";
const JP = "Jonathan Paz";
const N = "Nick Schoeben";
const JO = "Josh OConnor";
const D = "Daniel Figueiredo";
const C = "Curtis Westergard";
const L = "Leonardo Favero";
const BC = "Bradley Crouse";
const A = "Alfredo Castro";
const R = "Ronnell Watson";
const S = "Samuel Corona";
const BS = "Berat Sallarel";
const JV = "Jovanny Paz";
const E = "Edward Romero";

export const SEPT_SD_ROWS: SeptRow[] = [
  [16460, "Reload", "Reload", "Normal", "Non Member", "Completed", [BL]],
  [3320, "Upsell", "Upsell", "Normal", "Non Member", "Completed", [JO, BL]],
  [0, "Cancelled", "Upsell", "Normal", "Non Member", "Cancelled", [JH]],
  [11000, "Sale", "Canvass", "Normal", "Non Member", "Completed", [Y]],
  [16100, "Sale", "Canvass", "Normal", "Advantage+", "Completed", [G]],
  [0, "Cancelled", "Canvass", "Normal", "Non Member", "Cancelled", [E, JX]],
  [2550, "Upsell", "Upsell", "Normal", "Non Member", "Completed", [JX, G]],
  [5000, "Reload", "Reload", "Normal", "Non Member", "Completed", [JP]],
  [24440, "Upsell", "Upsell", "Normal", "Non Member", "Completed", [Y]],
  [28540, "Sale", null, "Normal", "Non Member", "Completed", [BL]],
  [16870, "Sale", "Job Walk", "Normal", "Non Member", "Completed", [JP, JH]],
  [10745, "Sale", "Canvass", "Normal", "Non Member", "Completed", [BL, JX]],
  [7837, "Sale", "Canvass", "Normal", "Non Member", "Completed", [G]],
  [3800, "Upsell", "Upsell", "Normal", "Non Member", "Completed", [Y]],
  [11250, "Upsell", "Upsell", "Normal", "Non Member", "Completed", [Y]],
  [29137, "Sale", "Canvass", "Marketing Home", "Advantage+", "Completed", [JO, N]],
  [5028, "Upsell", "Upsell", "Normal", "Non Member", "Completed", [Y]],
  [12583, "Upsell", "Upsell", "Normal", null, "Completed", [JO]],
  [32334, "Sale", "Canvass", "Normal", "Advantage+", "Completed", [JP]],
  [35500, "Sale", "Canvass", "Normal", "Non Member", "Completed", [JO, Y]],
  [0, "Cancelled", "Canvass", "Marketing Home", "Non Member", "Cancelled", [E, JX]],
  [10000, "Upsell", "Upsell", "Normal", null, "Completed", [JX, E]],
  [12900, "Reload", "Reload", "Normal", null, "Completed", [JX]],
  [24000, "Sale", "Room", "Normal", "Non Member", "Completed", [JX]],
  [45021, "Sale", "Canvass", "Normal", "Advantage+", "Completed", [D, G]],
  [21102, "Sale", "Canvass", "Normal", "Non Member", "Completed", [D, G]],
  [4000, "Upsell", "Upsell", "Normal", "Non Member", "Completed", [JO]],
  [5172, "Reload", "Reload", "Normal", "Non Member", "Completed", [Y]],
  [0, "Cancelled", "Canvass", "Normal", "Non Member", "Cancelled", [JX, E]],
  [5000, "Upsell", "Upsell", "Normal", "Non Member", "Completed", [Y, JX]],
  [0, "Cancelled", "Canvass", "Normal", "Non Member", "Cancelled", [JX, JV]],
  [19696, "Sale", "Canvass", "Normal", "Non Member", "Completed", [N, D]],
  [36873, "Sale", "Canvass", "Marketing Home", "Non Member", "Completed", [JH]],
  [5860, "Sale", "Canvass", "Normal", "Non Member", "Completed", [Y]],
  [47891, "Reload", "Reload", "Marketing Home", "Non Member", "Completed", [JX, G]],
  [4984, "Sale", "Canvass", "Marketing Home", "Non Member", "Completed", [JO]],
  [2992, "Reload", "Reload", "Normal", "Non Member", "Completed", [JH]],
  [4986, "Upsell", "Upsell", "Normal", "Non Member", "Completed", [JO]],
  [23588, "Reload", "Reload", "Normal", null, "Completed", [Y]],
  [2635, "Sale", "Reload", "Normal", "Non Member", "Completed", [JH]],
  [15872, "Sale", "Canvass", "Normal", "Non Member", "Completed", [JX, JO]],
  [10507, "Sale", "Canvass", "Normal", "Non Member", "LVM", [Y, BL]],
  [18000, "Sale", "Canvass", "Normal", "Non Member", "Completed", [BL]],
  [0, "Cancelled", "Canvass", "Marketing Home", "Non Member", "Cancelled", [G]],
  [35502, "Sale", "Canvass", "Marketing Home", "Non Member", "Completed", [JX, JH]],
  [4936, "Reload", "Reload", "Normal", "Non Member", "Completed", [JX]],
  [12986, "Sale", "Canvass", "Normal", "Non Member", "Completed", [G, BL]],
  [33503, "Sale", "Canvass", "Marketing Home", "Non Member", "Completed", [G]],
  [1000, "Upsell", "Upsell", "Normal", null, "Completed", [BL]],
  [450, "Reload", "Reload", "Normal", null, "Completed", [Y]],
  [19528, "Sale", "Canvass", "Normal", "Non Member", "Completed", [Y]],
  [43018, "Sale", "Canvass", "Normal", "Advantage+", "Completed", [Y, JP]],
  [28300, "Sale", "Canvass", "Marketing Home", "Non Member", "Completed", [E, JX]],
  [14918, "Sale", "Canvass", "Normal", "Non Member", "Completed", [D, JH]],
  [4931, "Upsell", "Upsell", "Normal", null, "Completed", [JH]],
  [7771.18, "Upsell", "Upsell", "Normal", null, "Completed", [Y]],
  [10460, "Sale", "Canvass", "Normal", "Non Member", "Completed", [JH, JV]],
  [16001, "Sale", "Canvass", "Marketing Home", "Advantage+", "Completed", [N, D]],
  [48375, "Sale", "Canvass", "Marketing Home", "Non Member", "Completed", [JX, G]],
  [5200, "Sale", "job walk", "Normal", "Advantage+", "Completed", [N]],
  [1020, "Reload", "Reload", "Normal", null, "Completed", [Y]],
  [4800, "Reload", "Reload", "Normal", "Non Member", "Completed", [D, G]],
  [30249, "Sale", "Canvass", "Marketing Home", "Non Member", "LVM", [JV, JH]],
  [505, "Upsell", "Upsell", "Normal", "Non Member", "Completed", [JX, JO]],
  [22183, "Sale", "Job Walk", "Normal", "Non Member", "Completed", [JH]],
  [45393, "Sale", "Canvass", "Marketing Home", "Non Member", "Completed", [JP]],
  [72696, "Sale", "Canvass", "Marketing Home", "Non Member", "Completed", [N]],
  [26648, "Sale", "Canvass", "Normal", "Non Member", "Completed", [JX]],
  [1496, "Reload", "Reload", "Normal", "Advantage+", "Completed", [G]],
  [24919, "Reload", "Reload", "Normal", "Non Member", "Completed", [BL]],
  [138490, "Sale", "Job Walk", "Normal", "Non Member", "Completed", [Y]],
  [23448, null, "Job Walk", "Normal", "Non Member", "Completed", [D, JH]],
];

export const SEPT_OC_ROWS: SeptRow[] = [
  [4000, "Upsell", "Upsell", "Normal", "Advantage+", "Completed", [R, BS]],
  [16389, "Reload", "Reload", "Normal", "Advantage+", "Completed", [R, BS]],
  [39487, "Sale", "Canvass", "Marketing Home", "Advantage+", "Completed", [L, BC]],
  [54620, "Sale", "Canvass", "Marketing Home", "Non Member", "Completed", [L, A]],
  [6500, "Sale", "Canvass", "Marketing Home", "Non Member", "Completed", [C]],
  [11636, "Sale", "Canvass", "Normal", "Non Member", "Completed", [R]],
  [8850, "Reload", "Reload", "Normal", "Non Member", "Completed", [BC, L]],
  [18589, null, "Canvass", "Marketing Home", "Non Member", "Completed", [S]],
  [11915, "Reload", "Reload", "Normal", null, "Completed", [BC, S]],
  [10995, "Reload", "Reload", "Normal", null, "Completed", [R, BS]],
  [14887, "Sale", "Canvass", "Marketing Home", "Non Member", "Completed", [S, C]],
  [9675, null, "Job Walk", "Normal", null, "Completed", [C, L]],
  [13000, "Sale", "Canvass", "Marketing Home", "Non Member", "Completed", [A, C]],
  [19495, "Sale", "Room", "Normal", "Non Member", "LVM", [R, C]],
  [26345, "Sale", "Room", "Marketing Home", null, "LVM", [C]],
  [29923, "Sale", "Canvass", "Marketing Home", "Advantage+", "Completed", [A, BC]],
];

/** The owner's calibration figures (money rules only, ±1 for rounding). */
export const SEPT_EXPECTED: Record<string, number> = {
  [Y]: 390,
  [JX]: 230,
  [G]: 210,
  [JH]: 184,
  [BL]: 150,
  [JP]: 145,
  [N]: 140,
  [JO]: 99,
  [D]: 97,
  [C]: 90,
  [L]: 73,
  [BC]: 66,
  [A]: 62,
  [R]: 59,
  [S]: 49,
  [BS]: 30,
  [JV]: 27,
  [E]: 25,
};
