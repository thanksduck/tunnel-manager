#!/usr/bin/env bun
import { parseArgs } from "node:util";
import pkg from "../package.json";
import {
  bringUp,
  createTunnel,
  detectTailnet,
  editTunnel,
  importRunning,
  planUp,
  restart,
  snapshot,
  switchTailnet,
  takeDown,
  tunnelsOnActiveTailnet,
  type Snap,
  type TunnelInput,
  type View,
} from "./core";
import { deleteTunnel, listEvents } from "./db";
import { daemonStatus, installDaemon, runDaemon, uninstallDaemon } from "./daemon";
import { DB_PATH, logPath } from "./paths";
import { logTail, parseForward } from "./ssh";
import { bold, cyan, dim, fit, fmtTime, gray, green, layout, red, row, yellow } from "./ui/ansi";
import { summary, TUNNEL_COLS, tunnelCells } from "./ui/tunnels";

const HELP = `${bold("tnl")} ${dim(`v${pkg.version}`)} — Tailscale-aware SSH tunnel manager

${bold("Usage")}
  tnl                              open the live dashboard
  tnl ls [--json]                  list tunnels and their state
  tnl add <name> <[user@]host> <local>:[rhost:]<rport> [options]
        --service <s>  --tailnet <name|none>  --fallback <host>  --note <text>  --up
  tnl up <name...|all> [-y]        start (and keep alive) tunnels
  tnl down <name...|all>           stop tunnels
  tnl restart <name...|all>
  tnl set <name> key=value ...     keys: name host local remote service tailnet fallback note
  tnl rm <name...> [-y]
  tnl logs <name> [-n 40]          history and ssh output
  tnl import                       adopt ssh -L processes that are already running
  tnl ts                           Tailscale accounts and machines
  tnl ts switch <tailnet> [-y]     switch account (shows which tunnels drop)
  tnl daemon install|uninstall|status|run    background supervisor (launchd)

${bold("Example")}
  tnl add wellvibe-db root@wellvibe 17600:5432 --up

${dim(`data: ${DB_PATH}`)}`;

class UsageError extends Error {}

const ok = (msg: string) => console.log(`${green("✔")} ${msg}`);
const warn = (msg: string) => console.log(`${yellow("!")} ${msg}`);
const bad = (msg: string) => console.error(`${red("✖")} ${msg}`);

function ask(question: string, yes: boolean): boolean {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new UsageError(`${question} — re-run with -y to confirm`);
  return confirm(question);
}

function printTable(views: View[]) {
  if (!views.length) return console.log(dim("no tunnels — try `tnl import` or `tnl add`"));
  const cells = views.map(tunnelCells);
  const widths = layout(TUNNEL_COLS, cells, process.stdout.columns || 140);
  console.log(dim(row(TUNNEL_COLS.map((c) => c.title), TUNNEL_COLS, widths)).trimEnd());
  for (const c of cells) console.log(row(c, TUNNEL_COLS, widths).trimEnd());
}

function pick(snap: Snap, names: string[]): View[] {
  if (!names.length) throw new UsageError("which tunnel? give one or more names, or `all`");
  if (names.length === 1 && names[0] === "all") return snap.views;
  return names.map((n) => {
    const v = snap.views.find((x) => x.name === n);
    if (!v) throw new UsageError(`no tunnel named ${n}`);
    return v;
  });
}

/** Polls until the given tunnels leave the "starting" state, then prints them. */
async function settle(ids: number[]) {
  let snap = await snapshot();
  for (let i = 0; i < 16; i++) {
    const mine = snap.views.filter((v) => ids.includes(v.id));
    if (mine.every((v) => v.status !== "starting")) break;
    await Bun.sleep(500);
    snap = await snapshot();
  }
  const mine = snap.views.filter((v) => ids.includes(v.id));
  printTable(mine);
  if (!snap.daemon.alive && mine.some((v) => v.desired === "up")) {
    warn("supervisor is not running, so dropped tunnels will not reconnect. Enable it with: tnl daemon install");
  }
  if (mine.some((v) => v.status === "dropped" || v.status === "blocked")) process.exitCode = 1;
}

function switchQuestion(snap: Snap, to: string): string {
  const drops = tunnelsOnActiveTailnet(snap).map((v) => v.name);
  const from = snap.ts.active?.tailnet ?? "none";
  return `Switch Tailscale ${from} → ${to}?${drops.length ? ` This drops: ${drops.join(", ")}.` : ""}`;
}

async function cmdUp(names: string[], yes: boolean) {
  let snap = await snapshot();
  const targets = pick(snap, names);
  const all = names[0] === "all";
  const started: number[] = [];
  for (const target of targets) {
    const v = snap.views.find((x) => x.id === target.id)!;
    const plan = planUp(v, snap);
    if (plan.kind === "unavailable") {
      bad(`${v.name}: ${plan.reason}`);
      continue;
    }
    if (plan.kind === "switch") {
      // `up all` must not flip accounts back and forth; those tunnels wait for their tailnet
      if (all || !ask(switchQuestion(snap, plan.profile.tailnet), yes)) {
        warn(`${v.name}: skipped, needs tailnet ${plan.profile.tailnet}`);
        continue;
      }
      await switchTailnet(plan.profile);
      ok(`switched to ${plan.profile.tailnet}`);
      snap = await snapshot(true);
    } else if (plan.via === "fallback") {
      warn(`${v.name}: tailnet ${v.tailnet} is inactive, using fallback ${v.fallback}`);
    }
    const res = await bringUp(v.id);
    if (!res.ok) bad(`${v.name}: ${res.error}`);
    started.push(v.id);
  }
  if (started.length) await settle(started);
}

function parseKV(args: string[]): Record<string, string> {
  return Object.fromEntries(
    args.map((a) => {
      const i = a.indexOf("=");
      if (i < 1) throw new UsageError(`expected key=value, got ${a}`);
      return [a.slice(0, i), a.slice(i + 1)];
    }),
  );
}

async function main() {
  const { values: flags, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      yes: { type: "boolean", short: "y" },
      json: { type: "boolean" },
      up: { type: "boolean" },
      lines: { type: "string", short: "n" },
      service: { type: "string" },
      tailnet: { type: "string" },
      fallback: { type: "string" },
      note: { type: "string" },
    },
  });
  const [cmd, ...args] = positionals;
  const yes = !!flags.yes;

  if (flags.version) return console.log(pkg.version);
  if (flags.help || cmd === "help") return console.log(HELP);

  switch (cmd) {
    case undefined: {
      if (process.stdin.isTTY && process.stdout.isTTY) return (await import("./ui/tui")).runTui();
      return printTable((await snapshot()).views);
    }

    case "ls":
    case "list":
    case "status": {
      const snap = await snapshot();
      if (flags.json) return console.log(JSON.stringify(snap.views, null, 2));
      printTable(snap.views);
      if (snap.views.length) {
        const ts = snap.ts.active ? `tailnet ${snap.ts.active.tailnet}` : "tailscale inactive";
        console.log(`\n${summary(snap.views)}   ${dim(`${ts} · supervisor ${snap.daemon.alive ? "on" : "off"}`)}`);
      }
      return;
    }

    case "add": {
      const [name, host, spec] = args;
      if (!name || !host || !spec) throw new UsageError("usage: tnl add <name> <[user@]host> <local>:[rhost:]<rport>");
      const fw = parseForward(spec.split(":").length === 2 ? spec.replace(":", ":localhost:") : spec);
      if (!fw) throw new UsageError(`cannot read forward "${spec}" — expected e.g. 17600:5432 or 17600:localhost:5432`);
      const snap = await snapshot();
      const tailnet =
        flags.tailnet === undefined ? await detectTailnet(host, snap.ts) : flags.tailnet === "none" ? null : flags.tailnet;
      const t = createTunnel({
        name, host, local_port: fw.lport, remote_host: fw.rhost, remote_port: fw.rport,
        service: flags.service, tailnet, fallback: flags.fallback, note: flags.note,
      });
      ok(`added ${bold(t.name)}: localhost:${t.local_port} → ${t.host} → ${t.remote_host}:${t.remote_port}` + dim(tailnet ? `  (tailnet ${tailnet})` : "  (no tailnet)"));
      if (flags.up) await cmdUp([t.name], yes);
      return;
    }

    case "up":
    case "start":
      return cmdUp(args, yes);

    case "down":
    case "stop": {
      const targets = pick(await snapshot(), args);
      for (const v of targets) await takeDown(v.id);
      ok(`stopped ${targets.map((v) => v.name).join(", ") || "nothing"}`);
      return;
    }

    case "restart": {
      const targets = pick(await snapshot(), args).filter((v) => args[0] !== "all" || v.desired === "up");
      for (const v of targets) {
        const res = await restart(v.id);
        if (!res.ok) bad(`${v.name}: ${res.error}`);
      }
      return settle(targets.map((v) => v.id));
    }

    case "rm":
    case "remove": {
      for (const v of pick(await snapshot(), args)) {
        if (!ask(`Delete tunnel ${v.name} (local port ${v.local_port})?`, yes)) continue;
        await takeDown(v.id);
        deleteTunnel(v.id);
        ok(`deleted ${v.name}`);
      }
      return;
    }

    case "set":
    case "edit": {
      const [name, ...kv] = args;
      const [v] = pick(await snapshot(), name ? [name] : []);
      const patch = parseKV(kv);
      const input: TunnelInput = {
        name: v!.name, host: v!.host, local_port: v!.local_port, remote_host: v!.remote_host, remote_port: v!.remote_port,
        service: v!.service, tailnet: v!.tailnet, fallback: v!.fallback, note: v!.note,
      };
      for (const [k, val] of Object.entries(patch)) {
        if (k === "local") input.local_port = Number(val);
        else if (k === "remote") {
          const [h, p] = val.includes(":") ? val.split(":") : ["localhost", val];
          input.remote_host = h!;
          input.remote_port = Number(p);
        } else if (k === "name" || k === "host") input[k] = val;
        else if (k === "service" || k === "tailnet" || k === "fallback" || k === "note") input[k] = val === "" || val === "none" ? null : val;
        else throw new UsageError(`unknown key ${k} — use name host local remote service tailnet fallback note`);
      }
      const { restarted } = await editTunnel(v!.id, input);
      ok(`updated ${input.name}`);
      if (restarted) await settle([v!.id]);
      return;
    }

    case "logs":
    case "log": {
      const [v] = pick(await snapshot(), args.slice(0, 1));
      const n = Number(flags.lines) || 40;
      console.log(bold("history"));
      for (const e of listEvents(v!.id, 15).reverse()) console.log(`  ${dim(fmtTime(e.ts))}  ${fit(e.kind, 7)} ${e.msg}`);
      console.log(`\n${bold("ssh output")} ${dim(logPath(v!.name))}`);
      for (const l of logTail(v!.name, n)) console.log(`  ${l.startsWith("--- ") ? dim(l) : l}`);
      return;
    }

    case "import": {
      const { added, notes } = await importRunning();
      if (!added.length) return console.log(dim("no unmanaged ssh -L processes found"));
      for (const t of added) ok(`imported ${bold(t.name)}: localhost:${t.local_port} → ${t.host} → ${t.remote_host}:${t.remote_port}`);
      for (const n of notes) warn(n);
      return;
    }

    case "ts":
    case "tailscale": {
      const snap = await snapshot(true);
      const ts = snap.ts;
      if (args[0] === "switch") {
        const p = ts.profiles.find((x) => x.tailnet === args[1] || x.id === args[1] || x.account === args[1]);
        if (!p) throw new UsageError(`no Tailscale account matches "${args[1] ?? ""}" — known: ${ts.profiles.map((x) => x.tailnet).join(", ")}`);
        if (p.active) return ok(`${p.tailnet} is already active`);
        if (!ask(switchQuestion(snap, p.tailnet), yes)) return;
        await switchTailnet(p);
        return ok(`switched to ${p.tailnet}`);
      }
      if (!ts.available) return bad(ts.error ?? "tailscale CLI not found");
      console.log(bold("Accounts"));
      for (const p of ts.profiles) {
        console.log(`  ${p.active ? green("●") : gray("○")} ${fit(p.tailnet, 20)} ${dim(p.account)}${p.active ? green("  active") : ""}`);
      }
      console.log(`\n${bold("Machines")} ${dim(`on ${ts.active?.tailnet ?? "?"} (${ts.backend})`)}`);
      for (const p of ts.peers) {
        const n = snap.views.filter((v) => v.host.slice(v.host.indexOf("@") + 1) === p.label).length;
        console.log(`  ${p.online ? green("●") : gray("○")} ${fit(p.label, 22)} ${dim(fit(p.ip, 16))} ${dim(fit(p.os, 8))}${p.self ? dim("this machine") : n ? cyan(`${n} tunnel${n === 1 ? "" : "s"}`) : ""}`);
      }
      return;
    }

    case "daemon": {
      const sub = args[0] ?? "status";
      if (sub === "run") return runDaemon();
      if (sub === "install") {
        const path = await installDaemon();
        await Bun.sleep(1500);
        const st = await daemonStatus();
        return st.alive ? ok(`supervisor running (pid ${st.pid}) — ${dim(path)}`) : warn(`installed ${path} but no heartbeat yet; check ${st.log}`);
      }
      if (sub === "uninstall") {
        const removed = await uninstallDaemon();
        return ok(removed ? "supervisor removed; running tunnels were left alone" : "supervisor was not installed");
      }
      if (sub === "status") {
        const st = await daemonStatus();
        console.log(`${st.alive ? green("● running") : red("○ not running")}${st.pid ? dim(`  pid ${st.pid}`) : ""}`);
        console.log(dim(`launchd: ${st.installed ? (st.loaded ? "installed and loaded" : "installed, not loaded") : "not installed"}  (${st.plist})`));
        console.log(dim(`log: ${st.log}`));
        return;
      }
      throw new UsageError("usage: tnl daemon install|uninstall|status|run");
    }

    default:
      throw new UsageError(`unknown command "${cmd}" — see tnl --help`);
  }
}

try {
  await main();
} catch (e) {
  bad(e instanceof Error ? e.message : String(e));
  process.exit(e instanceof UsageError ? 2 : 1);
}
