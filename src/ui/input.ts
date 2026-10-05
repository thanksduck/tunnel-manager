export type InputEvent =
  | { type: "key"; name: string }
  | { type: "char"; ch: string }
  | { type: "mouse"; kind: "press" | "release" | "wheelup" | "wheeldown"; x: number; y: number };

const CSI: Record<string, string> = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "shift-tab",
  "1~": "home", "3~": "delete", "4~": "end", "5~": "pageup", "6~": "pagedown",
};

const CTRL: Record<string, string> = {
  "\r": "enter", "\n": "enter", "\t": "tab", "\x7f": "backspace", "\b": "backspace", "\x03": "ctrl-c", "\x04": "ctrl-d",
  "\x15": "ctrl-u", "\x17": "ctrl-w",
};

/** Decodes a chunk of raw-mode stdin into key, text and SGR mouse events (0-based coordinates). */
export function parseInput(data: string): InputEvent[] {
  const events: InputEvent[] = [];
  let i = 0;
  while (i < data.length) {
    const rest = data.slice(i);
    const mouse = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (mouse) {
      i += mouse[0].length;
      const b = Number(mouse[1]);
      const x = Number(mouse[2]) - 1;
      const y = Number(mouse[3]) - 1;
      if (b & 64) events.push({ type: "mouse", kind: b & 1 ? "wheeldown" : "wheelup", x, y });
      else if ((b & 3) === 0 && !(b & 32)) events.push({ type: "mouse", kind: mouse[4] === "M" ? "press" : "release", x, y });
      continue;
    }
    const csi = rest.match(/^\x1b(?:\[|O)([\d;]*[A-Za-z~])/);
    if (csi) {
      i += csi[0].length;
      const name = CSI[csi[1]!];
      if (name) events.push({ type: "key", name });
      continue;
    }
    const ch = String.fromCodePoint(data.codePointAt(i)!);
    i += ch.length;
    if (ch === "\x1b") events.push({ type: "key", name: "escape" });
    else if (CTRL[ch]) events.push({ type: "key", name: CTRL[ch] });
    else if (ch >= " ") events.push({ type: "char", ch });
  }
  return events;
}
