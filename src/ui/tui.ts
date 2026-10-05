import {
  bringUp,
  createTunnel,
  detectTailnet,
  editTunnel,
  importRunning,
  inferService,
  nextFreePort,
  planUp,
  restart,
  snapshot,
  switchTailnet,
  takeDown,
  tunnelsOnActiveTailnet,
  type Snap,
  type TunnelInput,
  type View,
} from "../core";
import { deleteTunnel, listEvents, type Tunnel } from "../db";
import { configHosts, logTail, sshArgs, type ConfigHost } from "../ssh";
import type { Peer, Profile } from "../tailscale";
import {
  bgBar, bgSelect, bold, center, cyan, dim, fit, fmtDuration, fmtTime, gray, green, inverse, layout, red, row, statusBadge,
  width, yellow,
} from "./ansi";
import { parseInput, type InputEvent } from "./input";
import { summary, TUNNEL_COLS, tunnelCells } from "./tunnels";

type Tab = "tunnels" | "machines";

interface Field {
  key: string;
  label: string;
  value: string;
  hint: string;
}

type Modal =
  | { type: "confirm"; title: string; body: string[]; onYes: () => void }
  | { type: "form"; title: string; fields: Field[]; idx: number; error: string | null; submit: (v: Record<string, string>) => Promise<void> }
  | { type: "logs"; id: number; name: string };

type Item = { kind: "profile"; p: Profile } | { kind: "peer"; peer: Peer } | { kind: "host"; h: ConfigHost };

interface Hit {
  y: number;
  x0: number;
  x1: number;
  fn: () => void;
}

const REFRESH_MS = 2000;
const DOUBLE_CLICK_MS = 450;

export async function runTui(): Promise<void> {
  const out = process.stdout;
  const inp = process.stdin;

  let snap: Snap = await snapshot();
  const hosts = configHosts();
  let tab: Tab = "tunnels";
  const sel: Record<Tab, number> = { tunnels: 0, machines: 0 };
  const scroll: Record<Tab, number> = { tunnels: 0, machines: 0 };
  let modal: Modal | null = null;
  let flash: { msg: string; kind: "ok" | "err" | "info"; until: number } | null = null;
  let busy = false;
  let hits: Hit[] = [];
  let lastClick = { key: "", at: 0 };
  let lastFrame = "";
  let refreshing = false;

  // ── data ──────────────────────────────────────────────────────────────────

  const items = (): Item[] => [
    ...snap.ts.profiles.map((p) => ({ kind: "profile" as const, p })),
    ...snap.ts.peers.filter((p) => !p.self).map((peer) => ({ kind: "peer" as const, peer })),
    ...hosts.map((h) => ({ kind: "host" as const, h })),
  ];
  const count = () => (tab === "tunnels" ? snap.views.length : items().length);
  const current = (): View | undefined => snap.views[sel.tunnels];

  async function refresh(freshTs = false) {
    if (refreshing) return;
    refreshing = true;
    try {
      snap = await snapshot(freshTs);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), "err");
    }
    refreshing = false;
    render();
  }

  function say(msg: string, kind: "ok" | "err" | "info" = "info", ms = 5000) {
    flash = { msg, kind, until: Date.now() + ms };
  }

  async function act(label: string, fn: () => Promise<string | void>) {
    if (busy) return;
    busy = true;
    say(`${label}…`, "info", 60_000);
    render();
    try {
      say((await fn()) ?? `${label}: done`, "ok");
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), "err", 9000);
    }
    busy = false;
    await refresh(true);
  }

  // ── actions ───────────────────────────────────────────────────────────────

  async function start(id: number) {
    const res = await bringUp(id);
    if (!res.ok) throw new Error(res.error);
  }

  function confirmSwitch(profile: Profile, then: () => Promise<string | void>, why: string) {
    const drops = tunnelsOnActiveTailnet(snap).map((v) => v.name);
    modal = {
      type: "confirm",
      title: `Switch Tailscale to ${profile.tailnet}?`,
      body: [
        why,
        "",
        ...(drops.length
          ? [`Tunnels that will drop until you switch back:`, ...drops.map((d) => `  ${red("•")} ${d}`)]
          : [dim("No running tunnel uses the current tailnet.")]),
      ],
      onYes: () =>
        void act(`switching to ${profile.tailnet}`, async () => {
          await switchTailnet(profile);
          return then();
        }),
    };
  }

  function startFlow(v: View) {
    const plan = planUp(v, snap);
    if (plan.kind === "unavailable") return say(plan.reason, "err");
    if (plan.kind === "switch") {
      return confirmSwitch(
        plan.profile,
        async () => {
          await start(v.id);
          return `switched to ${plan.profile.tailnet}, starting ${v.name}`;
        },
        `${bold(v.name)} lives on ${plan.profile.tailnet}; the active account is ${snap.ts.active?.tailnet ?? "none"}.`,
      );
    }
    void act(`starting ${v.name}`, async () => {
      await start(v.id);
      return plan.via === "fallback" ? `starting ${v.name} over fallback ${v.fallback}` : `starting ${v.name}`;
    });
  }

  function toggle() {
    const v = current();
    if (!v) return;
    if (v.desired === "up") void act(`stopping ${v.name}`, () => takeDown(v.id).then(() => `stopped ${v.name}`));
    else startFlow(v);
  }

  function doRestart() {
    const v = current();
    if (!v) return;
    if (!v.route) return startFlow(v);
    void act(`restarting ${v.name}`, async () => {
      const res = await restart(v.id);
      if (!res.ok) throw new Error(res.error);
      return `restarted ${v.name}`;
    });
  }

  function doDelete() {
    const v = current();
    if (!v) return;
    modal = {
      type: "confirm",
      title: `Delete ${v.name}?`,
      body: [`${v.host} ${dim("→")} ${v.remote_host}:${v.remote_port} on local port ${v.local_port}`, "", "The tunnel is stopped and its definition removed."],
      onYes: () =>
        void act(`deleting ${v.name}`, async () => {
          await takeDown(v.id);
          deleteTunnel(v.id);
          return `deleted ${v.name}`;
        }),
    };
  }

  function tunnelForm(title: string, init: Partial<Tunnel>, editing?: Tunnel) {
    const f = (key: string, label: string, value: unknown, hint: string): Field => ({ key, label, value: value == null ? "" : String(value), hint });
    modal = {
      type: "form",
      title,
      idx: 0,
      error: null,
      fields: [
        f("name", "Name", init.name, "blank = host-service"),
        f("host", "SSH host", init.host, "[user@]host — Tailscale name or ~/.ssh/config alias"),
        f("local_port", "Local port", init.local_port, "port on this Mac"),
        f("remote_host", "Remote host", init.remote_host ?? "localhost", "as seen from the server"),
        f("remote_port", "Remote port", init.remote_port, "5432 postgres · 3306 mysql · 6379 redis"),
        f("service", "Service", init.service, "blank = guess from port"),
        f("tailnet", "Tailnet", editing ? (init.tailnet ?? "none") : "auto", "auto · none · tailnet name"),
        f("fallback", "Fallback", init.fallback, "ssh host to use when that tailnet is inactive"),
        f("note", "Note", init.note, "optional"),
      ],
      submit: async (v) => {
        const host = v.host!.trim();
        const remote_port = Number(v.remote_port);
        const service = v.service!.trim() || inferService(remote_port);
        const tn = v.tailnet!.trim();
        const input: TunnelInput = {
          name: v.name!.trim() || `${host.slice(host.indexOf("@") + 1).split(".")[0]}-${service ?? v.local_port}`,
          host,
          local_port: Number(v.local_port),
          remote_host: v.remote_host!.trim(),
          remote_port,
          service,
          tailnet: tn === "auto" ? await detectTailnet(host, snap.ts) : tn === "" || tn === "none" ? null : tn,
          fallback: v.fallback!.trim() || null,
          note: v.note!.trim() || null,
        };
        if (editing) {
          const { restarted } = await editTunnel(editing.id, input);
          say(restarted ? `saved ${input.name} and restarted it` : `saved ${input.name}`, "ok");
        } else {
          const t = createTunnel(input);
          tab = "tunnels";
          await refresh();
          sel.tunnels = Math.max(0, snap.views.findIndex((x) => x.id === t.id));
          say(`added ${t.name} — press enter to start it`, "ok");
        }
      },
    };
  }

  function addFor(host?: string) {
    tunnelForm(host ? `New tunnel to ${host}` : "New tunnel", { host, local_port: nextFreePort(snap.scan), remote_port: 5432 });
    if (host && modal?.type === "form") modal.idx = 2;
  }

  function activateItem() {
    const it = items()[sel.machines];
    if (!it) return;
    if (it.kind === "profile") {
      if (it.p.active) return say(`${it.p.tailnet} is already the active account`);
      return confirmSwitch(it.p, async () => `switched to ${it.p.tailnet}`, `Active account is ${snap.ts.active?.tailnet ?? "none"}.`);
    }
    if (it.kind === "peer") return addFor(it.peer.os === "linux" ? `root@${it.peer.label}` : it.peer.label);
    addFor(it.h.name);
  }

  // ── input ─────────────────────────────────────────────────────────────────

  function move(d: number) {
    const n = count();
    if (n) sel[tab] = Math.min(n - 1, Math.max(0, sel[tab] + d));
  }

  async function submitForm(m: Extract<Modal, { type: "form" }>) {
    try {
      await m.submit(Object.fromEntries(m.fields.map((f) => [f.key, f.value])));
      modal = null;
      await refresh();
    } catch (e) {
      m.error = e instanceof Error ? e.message : String(e);
    }
  }

  function modalKey(ev: InputEvent, k: string) {
    const m = modal!;
    if (k === "escape") return void (modal = null);
    if (m.type === "logs") {
      if (k === "q" || k === "l" || k === "enter") modal = null;
      return;
    }
    if (m.type === "confirm") {
      if (k === "y" || k === "enter") {
        modal = null;
        m.onYes();
      } else if (k === "n" || k === "q") modal = null;
      return;
    }
    const field = m.fields[m.idx]!;
    if (ev.type === "char") field.value += ev.ch;
    else if (k === "backspace") field.value = [...field.value].slice(0, -1).join("");
    else if (k === "ctrl-u") field.value = "";
    else if (k === "tab" || k === "down") m.idx = (m.idx + 1) % m.fields.length;
    else if (k === "shift-tab" || k === "up") m.idx = (m.idx + m.fields.length - 1) % m.fields.length;
    else if (k === "enter") void submitForm(m).then(render);
  }

  function key(k: string) {
    if (k === "tab" || k === "shift-tab" || k === "left" || k === "right") return void (tab = tab === "tunnels" ? "machines" : "tunnels");
    if (k === "1") return void (tab = "tunnels");
    if (k === "2") return void (tab = "machines");
    if (k === "q") return quit();
    if (k === "up" || k === "k") return move(-1);
    if (k === "down" || k === "j") return move(1);
    if (k === "pageup") return move(-10);
    if (k === "pagedown") return move(10);
    if (k === "home" || k === "g") return move(-1e9);
    if (k === "end" || k === "G") return move(1e9);
    if (k === "R") return void refresh(true);
    if (tab === "machines") {
      if (k === "enter" || k === " " || k === "a") activateItem();
      return;
    }
    if (k === "enter" || k === " ") return toggle();
    if (k === "r") return doRestart();
    if (k === "a") return addFor();
    if (k === "d") return doDelete();
    if (k === "e") {
      const v = current();
      if (v) tunnelForm(`Edit ${v.name}`, v, v);
    } else if (k === "l") {
      const v = current();
      if (v) modal = { type: "logs", id: v.id, name: v.name };
    } else if (k === "i") {
      void act("importing running tunnels", async () => {
        const { added, notes } = await importRunning();
        return added.length ? `imported ${added.map((t) => t.name).join(", ")}${notes.length ? ` — ${notes[0]}` : ""}` : "no unmanaged ssh -L processes found";
      });
    }
  }

  function onEvent(ev: InputEvent) {
    if (ev.type === "mouse") {
      if (ev.kind === "wheelup" || ev.kind === "wheeldown") {
        if (!modal) move(ev.kind === "wheelup" ? -1 : 1);
      } else if (ev.kind === "press") hits.find((h) => h.y === ev.y && ev.x >= h.x0 && ev.x < h.x1)?.fn();
      return;
    }
    const k = ev.type === "key" ? ev.name : ev.ch;
    if (k === "ctrl-c") return quit();
    if (modal) return modalKey(ev, k);
    key(k);
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  function header(W: number): string {
    let left = ` ${bold(cyan("tnl"))}  `;
    for (const [id, label] of [["tunnels", "Tunnels"], ["machines", "Machines"]] as const) {
      const x0 = width(left);
      left += tab === id ? inverse(bold(` ${label} `)) : dim(` ${label} `);
      hits.push({ y: 0, x0, x1: width(left), fn: () => void ((tab = id), (modal = null)) });
      left += " ";
    }
    const ts = snap.ts;
    const tailnet = !ts.available
      ? gray("tailscale not installed")
      : ts.running
        ? `${dim("tailnet")} ${green(ts.active?.tailnet ?? "?")}`
        : `${dim("tailscale")} ${yellow(ts.backend || "stopped")}`;
    const sup = `${dim("supervisor")} ${snap.daemon.alive ? green("● on") : red("○ off")}`;
    let right = `${tailnet}   ${sup} `;
    if (width(left) + width(right) > W) right = `${sup} `;
    if (width(left) + width(right) > W) right = "";
    return left + " ".repeat(Math.max(0, W - width(left) - width(right))) + right;
  }

  function footer(W: number, y: number): string {
    const keys: [string, string, string?][] =
      modal?.type === "form"
        ? [["tab", "next field"], ["enter", "save"], ["esc", "cancel", "escape"]]
        : modal?.type === "confirm"
          ? [["y", "yes"], ["n", "no"]]
          : modal?.type === "logs"
            ? [["esc", "back", "escape"]]
            : tab === "tunnels"
              ? [["↑↓", "select"], ["enter", "start/stop"], ["r", "restart"], ["a", "add"], ["e", "edit"], ["d", "delete"], ["l", "logs"], ["i", "import"], ["tab", "machines"], ["q", "quit"]]
              : [["↑↓", "select"], ["enter", "switch account / new tunnel"], ["tab", "tunnels"], ["q", "quit"]];
    let line = " ";
    for (const [k, label, send] of keys) {
      const x0 = width(line);
      line += `${bold(k)} ${dim(label)}`;
      if (k !== "↑↓") hits.push({ y, x0, x1: width(line), fn: () => onEvent({ type: "key", name: send ?? k }) });
      line += "   ";
    }
    return bgBar(fit(line, W));
  }

  function statusLine(W: number): string {
    if (flash && Date.now() > flash.until) flash = null;
    if (flash) {
      const color = flash.kind === "err" ? red : flash.kind === "ok" ? green : yellow;
      return fit(` ${color(flash.kind === "err" ? "✖" : flash.kind === "ok" ? "✔" : "…")} ${flash.msg}`, W);
    }
    const warn = snap.daemon.alive ? "" : dim("   supervisor is off: dropped tunnels will not reconnect (tnl daemon install)");
    return fit(` ${summary(snap.views)}${warn}`, W);
  }

  /** Keeps the selection inside a window of `h` rows and returns the first visible row. */
  function windowStart(t: Tab, selRow: number, h: number, total: number): number {
    if (selRow < scroll[t]) scroll[t] = selRow;
    if (selRow >= scroll[t] + h) scroll[t] = selRow - h + 1;
    scroll[t] = Math.max(0, Math.min(scroll[t], Math.max(0, total - h)));
    return scroll[t];
  }

  function rowHit(y: number, W: number, t: Tab, i: number, activate: () => void) {
    hits.push({
      y, x0: 0, x1: W,
      fn: () => {
        const id = `${t}:${i}`;
        const dbl = lastClick.key === id && Date.now() - lastClick.at < DOUBLE_CLICK_MS;
        lastClick = { key: id, at: Date.now() };
        sel[t] = i;
        if (dbl) activate();
      },
    });
  }

  const selectable = (line: string, selected: boolean, W: number) =>
    selected ? bgSelect(fit(cyan("▌") + line, W)) : fit(" " + line, W);

  function detail(v: View, W: number, h: number): string[] {
    const label = (s: string) => dim(s.padEnd(9));
    const dest = v.route?.dest ?? v.host;
    const facts = [
      v.pid && v.uptimeMs != null ? `pid ${v.pid}` : null,
      v.via ? `via ${v.via}` : null,
      v.uptimeMs != null ? `up ${fmtDuration(v.uptimeMs)}` : null,
      `${v.restarts} restart${v.restarts === 1 ? "" : "s"}`,
      v.peer ? (v.peer.online ? green(`${v.peer.label} online`) : red(`${v.peer.label} offline`)) : null,
    ].filter(Boolean);
    const lines = [
      dim(`── ${v.name} ${"─".repeat(Math.max(0, W - width(v.name) - 4))}`),
      ` ${label("connect")}${cyan(`localhost:${v.local_port}`)}   ${dim(facts.join(" · "))}`,
      ` ${label("command")}ssh -N -L ${sshArgs(v, dest).slice(-2).join(" ")}`,
      ` ${label("status")}${statusBadge(v.status)}${v.detail ? `  ${v.detail}` : ""}${v.note ? dim(`  ${v.note}`) : ""}`,
      ...listEvents(v.id, Math.max(0, h - 4)).map((e) => ` ${label(e.kind)}${dim(fmtTime(e.ts))}  ${e.msg}`),
    ];
    return lines.slice(0, h).map((l) => fit(l, W));
  }

  function tunnelsBody(W: number, y0: number, h: number): string[] {
    const views = snap.views;
    if (!views.length) {
      const msg = ["No tunnels yet.", "", `${bold("i")} imports ssh -L processes that are already running`, `${bold("a")} adds one by hand, ${bold("tab")} picks a machine from Tailscale or ~/.ssh/config`];
      return [...Array(Math.max(0, Math.floor((h - msg.length) / 2))).fill(""), ...msg.map((m) => center(m, W))];
    }
    sel.tunnels = Math.min(sel.tunnels, views.length - 1);
    const cells = views.map(tunnelCells);
    const widths = layout(TUNNEL_COLS, cells, W - 2);
    const detailH = h >= 16 ? Math.min(9, Math.floor(h / 3)) : 0;
    const listH = Math.max(1, h - 1 - detailH);
    const first = windowStart("tunnels", sel.tunnels, listH, views.length);
    const lines = [fit(" " + dim(row(TUNNEL_COLS.map((c) => c.title), TUNNEL_COLS, widths)), W)];
    for (let i = first; i < Math.min(views.length, first + listH); i++) {
      rowHit(y0 + lines.length, W, "tunnels", i, toggle);
      lines.push(selectable(row(cells[i]!, TUNNEL_COLS, widths), i === sel.tunnels, W));
    }
    while (lines.length < 1 + listH) lines.push("");
    if (detailH) lines.push(...detail(views[sel.tunnels]!, W, detailH));
    return lines;
  }

  function machinesBody(W: number, y0: number, h: number): string[] {
    const all = items();
    sel.machines = Math.min(sel.machines, Math.max(0, all.length - 1));
    const tunnelsTo = (name: string) => snap.views.filter((v) => v.host.slice(v.host.indexOf("@") + 1) === name).length;
    const badge = (n: number) => (n ? cyan(`${n} tunnel${n === 1 ? "" : "s"}`) : "");
    const rows: { text: string; item: number | null }[] = [];
    const section = (title: string) => rows.push({ text: "", item: null }, { text: bold(` ${title}`), item: null });
    let last = "";
    all.forEach((it, i) => {
      if (it.kind !== last) {
        section(it.kind === "profile" ? "Tailscale accounts" : it.kind === "peer" ? `Machines on ${snap.ts.active?.tailnet ?? "tailnet"}` : "~/.ssh/config hosts");
        last = it.kind;
      }
      let text: string;
      if (it.kind === "profile") {
        text = `${it.p.active ? green("●") : gray("○")} ${fit(it.p.tailnet, 20)} ${dim(fit(it.p.account, 40))} ${it.p.active ? green("active") : ""}`;
      } else if (it.kind === "peer") {
        const p = it.peer;
        text = `${p.online ? green("●") : gray("○")} ${fit(p.label, 20)} ${dim(fit(p.ip, 16))} ${dim(fit(p.os, 8))} ${badge(tunnelsTo(p.label))}`;
      } else {
        const h = it.h;
        const target = `${h.user ? `${h.user}@` : ""}${h.hostName ?? h.name}${h.port ? `:${h.port}` : ""}`;
        text = `${gray("·")} ${fit(h.name, 20)} ${dim(fit(target, 40))} ${badge(tunnelsTo(h.name))}`;
      }
      rows.push({ text: ` ${text}`, item: i });
    });
    if (!all.length) return ["", center(dim(snap.ts.error ?? "No Tailscale accounts or ssh config hosts found."), W)];
    const selRow = rows.findIndex((r) => r.item === sel.machines);
    // scroll far enough up that a section title above the selection stays visible
    let top = selRow;
    while (top > 0 && rows[top - 1]!.item === null) top--;
    if (top < scroll.machines) scroll.machines = top;
    const from = windowStart("machines", selRow, h, rows.length);
    return rows.slice(from, from + h).map((r, n) => {
      if (r.item === null) return fit(r.text, W);
      rowHit(y0 + n, W, "machines", r.item, activateItem);
      return selectable(r.text, r.item === sel.machines, W);
    });
  }

  function logsBody(m: Extract<Modal, { type: "logs" }>, W: number, h: number): string[] {
    const events = listEvents(m.id, Math.min(8, Math.floor(h / 3))).reverse();
    const lines = [
      bold(` ${m.name}`) + dim("  history"),
      ...events.map((e) => ` ${dim(fmtTime(e.ts))}  ${fit(e.kind, 7)} ${e.msg}`),
      "",
      bold(" ssh output") + dim("  ~/.tunnel-manager/logs/" + m.name + ".log"),
    ];
    const tail = logTail(m.name, Math.max(1, h - lines.length));
    lines.push(...(tail.length ? tail.map((l) => ` ${l.startsWith("--- ") ? dim(l) : l}`) : [dim(" (nothing logged yet)")]));
    return lines.slice(0, h).map((l) => fit(l, W));
  }

  function box(title: string, content: string[], w: number): string[] {
    const inner = w - 4;
    return [
      dim("╭─ ") + bold(title) + dim(` ${"─".repeat(Math.max(0, w - width(title) - 5))}╮`),
      ...content.map((c) => dim("│ ") + fit(c, inner) + dim(" │")),
      dim(`╰${"─".repeat(w - 2)}╯`),
    ];
  }

  function overlay(body: string[], W: number, y0: number): void {
    const m = modal;
    if (!m || m.type === "logs") return;
    const w = Math.max(20, Math.min(W - 2, 72));
    let content: string[];
    const buttons: { label: string; ch: string }[] = [];
    if (m.type === "confirm") {
      buttons.push({ label: `${inverse(" y ")} Yes`, ch: "y" }, { label: `${inverse(" n ")} No`, ch: "n" });
      content = [...m.body, "", buttons.map((b) => b.label).join("     ")];
    } else {
      content = m.fields.map((f, i) => {
        const active = i === m.idx;
        const value = active ? `${f.value}${inverse(" ")}` : f.value;
        const hint = active || !f.value ? dim(`  ${f.hint}`) : "";
        return `${active ? cyan("›") : " "} ${(active ? bold : dim)(f.label.padEnd(12))} ${value}${hint}`;
      });
      content.push("", m.error ? red(`✖ ${m.error}`) : dim("↑↓ or tab to move · enter to save · esc to cancel"));
    }
    const lines = box(m.title, content, w);
    const top = Math.max(0, Math.floor((body.length - lines.length) / 2));
    const left = Math.max(0, Math.floor((W - w) / 2));
    lines.forEach((l, i) => {
      if (top + i < body.length) body[top + i] = fit(" ".repeat(left) + l, W);
    });
    let x = left + 2;
    for (const b of buttons) {
      // the button row is the last content line: one above the bottom border
      hits.push({ y: y0 + top + lines.length - 2, x0: x, x1: x + width(b.label), fn: () => { onEvent({ type: "char", ch: b.ch }); render(); } });
      x += width(b.label) + 5;
    }
    if (m.type === "form") {
      m.fields.forEach((_, i) => hits.push({ y: y0 + top + 1 + i, x0: left, x1: left + w, fn: () => void (m.idx = i) }));
    }
  }

  function render() {
    const W = Math.max(20, out.columns || 80);
    const H = Math.max(6, out.rows || 24);
    hits = [];
    const bodyH = H - 4;
    const y0 = 2;
    let body =
      modal?.type === "logs" ? logsBody(modal, W, bodyH) : tab === "tunnels" ? tunnelsBody(W, y0, bodyH) : machinesBody(W, y0, bodyH);
    body = body.slice(0, bodyH);
    while (body.length < bodyH) body.push("");
    if (modal && modal.type !== "logs") hits = hits.filter((h) => h.y < y0); // clicks must not reach rows under a dialog
    overlay(body, W, y0);
    const lines = [header(W), dim("─".repeat(W)), ...body, statusLine(W), footer(W, H - 1)];
    const frame = lines.map((l) => `${l}\x1b[0m\x1b[K`).join("\r\n");
    if (frame === lastFrame) return;
    lastFrame = frame;
    out.write(`\x1b[?2026h\x1b[H${frame}\x1b[?2026l`);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));
  let closed = false;

  function restore() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    out.off("resize", onResize);
    inp.off("data", onData);
    inp.setRawMode(false);
    inp.pause();
    out.write("\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l");
  }

  function quit() {
    restore();
    finish();
  }

  const onResize = () => {
    lastFrame = "";
    render();
  };
  const onData = (chunk: Buffer) => {
    try {
      for (const ev of parseInput(chunk.toString("utf8"))) {
        onEvent(ev);
        if (closed) return;
      }
      render();
    } catch (e) {
      restore();
      throw e;
    }
  };

  out.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
  inp.setRawMode(true);
  inp.resume();
  inp.on("data", onData);
  out.on("resize", onResize);
  process.once("SIGTERM", quit);
  process.once("exit", restore);
  const timer = setInterval(() => void refresh(), REFRESH_MS);
  render();
  await finished;
}
