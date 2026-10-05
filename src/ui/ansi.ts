import type { Status } from "../core";

export const colorOn = !process.env.NO_COLOR && (!!process.stdout.isTTY || !!process.env.FORCE_COLOR);

const sgr = (open: string, close: string) => (s: string) => (colorOn ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const bold = sgr("1", "22");
export const dim = sgr("2", "22");
export const inverse = sgr("7", "27");
export const red = sgr("31", "39");
export const green = sgr("32", "39");
export const yellow = sgr("33", "39");
export const blue = sgr("34", "39");
export const magenta = sgr("35", "39");
export const cyan = sgr("36", "39");
export const gray = sgr("90", "39");
export const bgSelect = sgr("48;5;237", "49");
export const bgBar = sgr("48;5;235", "49");

export const width = (s: string) => Bun.stringWidth(s);

/** Truncates (with an ellipsis) or pads to exactly `w` columns, ANSI-aware. */
export function fit(s: string, w: number, right = false): string {
  if (w <= 0) return "";
  const len = width(s);
  if (len > w) return w === 1 ? "…" : Bun.sliceAnsi(s, 0, w - 1) + "…" + (colorOn ? "\x1b[39;22m" : "");
  const pad = " ".repeat(w - len);
  return right ? pad + s : s + pad;
}

export function center(s: string, w: number): string {
  const left = Math.max(0, Math.floor((w - width(s)) / 2));
  return fit(" ".repeat(left) + s, w);
}

export interface Col {
  title: string;
  min: number;
  max?: number;
  right?: boolean;
  /** columns with a higher number are hidden first when space runs out */
  drop?: number;
  /** takes whatever width is left over */
  grow?: boolean;
}

const GAP = 2;

/** Picks a width for every column (0 = hidden) so the table fits in `total` columns. */
export function layout(cols: Col[], rows: string[][], total: number): number[] {
  const w = cols.map((c, i) => {
    if (c.grow) return c.min; // sized from the leftover space below, never from its content
    const natural = Math.max(width(c.title), ...rows.map((r) => width(r[i] ?? "")));
    return Math.min(Math.max(natural, c.min), c.max ?? Infinity);
  });
  const used = () => w.reduce((a, x) => a + x, 0) + GAP * (w.filter(Boolean).length - 1);

  while (used() > total) {
    let victim = -1;
    cols.forEach((c, i) => {
      if (w[i] && c.drop && (victim < 0 || c.drop > cols[victim]!.drop!)) victim = i;
    });
    if (victim < 0) break;
    w[victim] = 0;
  }
  // still too wide: squeeze the widest column until it fits or everything is at its minimum
  while (used() > total) {
    let widest = -1;
    w.forEach((x, i) => {
      if (x > cols[i]!.min && (widest < 0 || x > w[widest]!)) widest = i;
    });
    if (widest < 0) break;
    w[widest]!--;
  }
  const grow = cols.findIndex((c, i) => c.grow && w[i]);
  if (grow >= 0 && used() < total) w[grow]! += total - used();
  return w;
}

export function row(cells: string[], cols: Col[], widths: number[]): string {
  return cells
    .map((c, i) => (widths[i] ? fit(c, widths[i]!, cols[i]!.right) : null))
    .filter((c) => c !== null)
    .join(" ".repeat(GAP));
}

const STATUS: Record<Status, [string, (s: string) => string]> = {
  up: ["●", green],
  starting: ["◐", yellow],
  retrying: ["◐", yellow],
  dropped: ["✖", red],
  blocked: ["⊘", magenta],
  down: ["○", gray],
};

export const statusBadge = (s: Status) => STATUS[s][1](`${STATUS[s][0]} ${s}`);
export const statusColor = (s: Status) => STATUS[s][1];

export function fmtDuration(ms: number | null): string {
  if (ms == null) return "";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  const day = d.toDateString() === new Date().toDateString() ? "" : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `;
  return `${day}${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
