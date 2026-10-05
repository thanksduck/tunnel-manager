import {
  addEvent,
  getMeta,
  getTunnel,
  getTunnelByName,
  insertTunnel,
  listTunnels,
  setMeta,
  updateTunnel,
  type NewTunnel,
  type Tunnel,
  type Via,
} from "./db";
import { killPid, lastLogError, pidAlive, resolveHost, scan, spawnTunnel, type Scan, type SshProc } from "./ssh";
import { findPeer, switchProfile, tsState, type Peer, type Profile, type TsState } from "./tailscale";

export type Status = "up" | "starting" | "down" | "retrying" | "dropped" | "blocked";

export interface Route {
  dest: string;
  via: Via;
}

export interface View extends Tunnel {
  status: Status;
  detail: string;
  uptimeMs: number | null;
  route: Route | null;
  peer: Peer | null;
}

export interface Snap {
  views: View[];
  ts: TsState;
  scan: Scan;
  daemon: { alive: boolean; pid: number | null };
}

const BACKOFF_S = [2, 5, 10, 20, 40, 60];
const STABLE_MS = 30_000;
const START_GRACE_MS = 4_000;

const bareHost = (dest: string) => dest.slice(dest.indexOf("@") + 1);

export function routeFor(t: Tunnel, ts: TsState): Route | null {
  if (!t.tailnet) return { dest: t.host, via: "direct" };
  if (ts.running && ts.active?.tailnet === t.tailnet) return { dest: t.host, via: "tailnet" };
  if (t.fallback) return { dest: t.fallback, via: "fallback" };
  return null;
}

/** Finds the live ssh process serving this tunnel, adopting one we did not start ourselves. */
function owned(t: Tunnel, sc: Scan): SshProc | null {
  const serves = (p: SshProc) => p.forwards.some((f) => f.lport === t.local_port && f.rport === t.remote_port);
  const proc = sc.procs.find((p) => p.pid === t.pid && serves(p)) ?? sc.procs.find(serves) ?? null;
  if (proc && proc.pid !== t.pid) {
    t.pid = proc.pid;
    t.started_at = Date.now() - proc.etimeMs;
    updateTunnel(t.id, { pid: t.pid, started_at: t.started_at });
  }
  return proc;
}

// ── supervisor heartbeat ────────────────────────────────────────────────────

export function daemonInfo(): Snap["daemon"] {
  try {
    const d = JSON.parse(getMeta("daemon") ?? "null") as { pid: number; ts: number } | null;
    if (d && Date.now() - d.ts < 10_000 && pidAlive(d.pid)) return { alive: true, pid: d.pid };
  } catch {}
  return { alive: false, pid: null };
}

export const heartbeat = () => setMeta("daemon", JSON.stringify({ pid: process.pid, ts: Date.now() }));
export const clearHeartbeat = () => setMeta("daemon", "null");

// ── read side ───────────────────────────────────────────────────────────────

function toView(t: Tunnel, sc: Scan, ts: TsState, daemonAlive: boolean): View {
  const proc = owned(t, sc);
  const route = routeFor(t, ts);
  const peer = t.tailnet && ts.active?.tailnet === t.tailnet ? (findPeer(ts, bareHost(t.host)) ?? null) : null;
  const base = { ...t, route, peer, uptimeMs: null as number | null };

  if (proc) {
    const listening = sc.listeners.get(t.local_port)?.pid === proc.pid;
    const uptimeMs = Date.now() - (t.started_at ?? Date.now() - proc.etimeMs);
    return { ...base, uptimeMs, status: listening ? "up" : "starting", detail: listening ? "" : "connecting…" };
  }
  if (t.desired === "down") return { ...base, status: "down", detail: "" };
  if (!route) return { ...base, status: "blocked", detail: `tailnet ${t.tailnet} is not the active account` };

  const squatter = sc.listeners.get(t.local_port);
  const err = squatter
    ? `local port ${t.local_port} is used by ${squatter.command} (pid ${squatter.pid})`
    : (t.last_error ?? lastLogError(t.name) ?? "ssh exited");
  if (!daemonAlive) return { ...base, status: "dropped", detail: err };
  const wait = Math.ceil((t.next_retry_at - Date.now()) / 1000);
  return { ...base, status: "retrying", detail: wait > 0 ? `${err} · retry in ${wait}s` : err };
}

export async function snapshot(freshTs = false): Promise<Snap> {
  const [sc, ts] = await Promise.all([scan(), tsState(freshTs)]);
  const daemon = daemonInfo();
  return { views: listTunnels().map((t) => toView(t, sc, ts, daemon.alive)), ts, scan: sc, daemon };
}

// ── write side ──────────────────────────────────────────────────────────────

export type StartResult = { ok: true } | { ok: false; error: string };

function startTunnel(id: number, ts: TsState, sc: Scan): StartResult {
  const t = getTunnel(id);
  if (!t) return { ok: false, error: "tunnel no longer exists" };
  if (owned(t, sc)) return { ok: true };
  // another tnl process (CLI vs supervisor) may have started it since `sc` was taken
  if (t.pid && t.started_at && Date.now() - t.started_at < START_GRACE_MS && pidAlive(t.pid)) return { ok: true };

  const fail = (error: string): StartResult => {
    updateTunnel(id, { last_error: error });
    return { ok: false, error };
  };
  const route = routeFor(t, ts);
  if (!route) return fail(`tailnet ${t.tailnet} is not the active account`);
  const squatter = sc.listeners.get(t.local_port);
  if (squatter) return fail(`local port ${t.local_port} is used by ${squatter.command} (pid ${squatter.pid})`);

  const pid = spawnTunnel(t, route.dest);
  updateTunnel(id, { pid, via: route.via, started_at: Date.now() });
  addEvent(id, "start", `ssh ${route.dest} (${route.via}), pid ${pid}`);
  return { ok: true };
}

/** Marks a tunnel as wanted and starts it now. */
export async function bringUp(id: number): Promise<StartResult> {
  updateTunnel(id, { desired: "up", fails: 0, next_retry_at: 0, last_error: null });
  const [sc, ts] = await Promise.all([scan(), tsState()]);
  return startTunnel(id, ts, sc);
}

async function killTunnel(t: Tunnel, sc: Scan) {
  const proc = owned(t, sc);
  if (proc) await killPid(proc.pid);
  updateTunnel(t.id, { pid: null, via: null, started_at: null, fails: 0, next_retry_at: 0, last_error: null });
}

export async function takeDown(id: number) {
  const t = getTunnel(id);
  if (!t) return;
  await killTunnel(t, await scan());
  updateTunnel(id, { desired: "down" });
  addEvent(id, "stop", "stopped by user");
}

export async function restart(id: number): Promise<StartResult> {
  const t = getTunnel(id);
  if (!t) return { ok: false, error: "tunnel no longer exists" };
  await killTunnel(t, await scan());
  return bringUp(id);
}

export type UpPlan =
  | { kind: "ok"; via: Via }
  | { kind: "switch"; profile: Profile; drops: string[] }
  | { kind: "unavailable"; reason: string };

/** What starting this tunnel would take, given which tailnet is active right now. */
export function planUp(t: Tunnel, snap: Snap): UpPlan {
  const route = routeFor(t, snap.ts);
  if (route) return { kind: "ok", via: route.via };
  if (!snap.ts.available) return { kind: "unavailable", reason: "Tailscale CLI not found" };
  const profile = snap.ts.profiles.find((p) => p.tailnet === t.tailnet);
  if (!profile) return { kind: "unavailable", reason: `tailnet ${t.tailnet} is not logged in on this machine` };
  if (profile.active) return { kind: "unavailable", reason: `Tailscale is ${snap.ts.backend || "not running"}` };
  return { kind: "switch", profile, drops: tunnelsOnActiveTailnet(snap).map((v) => v.name) };
}

export const tunnelsOnActiveTailnet = (snap: Snap) =>
  snap.views.filter((v) => v.via === "tailnet" && (v.status === "up" || v.status === "starting"));

/**
 * Switches Tailscale account. Tunnels riding the old tailnet are closed first
 * (they would hang until keepalive timeout) but stay wanted, so the supervisor
 * restores them when their tailnet is active again.
 */
export async function switchTailnet(profile: Profile) {
  const snap = await snapshot(true);
  for (const v of tunnelsOnActiveTailnet(snap)) {
    await killTunnel(v, snap.scan);
    addEvent(v.id, "drop", `tailnet switched to ${profile.tailnet}`);
  }
  await switchProfile(profile);
}

/** One supervisor pass: notice drops, restart wanted tunnels with backoff. */
export async function reconcile() {
  const [sc, ts] = await Promise.all([scan(), tsState()]);
  const now = Date.now();
  for (const t of listTunnels()) {
    if (t.pid && t.started_at && now - t.started_at < START_GRACE_MS) continue;
    if (owned(t, sc)) {
      if ((t.fails || t.last_error) && now - (t.started_at ?? now) > STABLE_MS) {
        updateTunnel(t.id, { fails: 0, last_error: null });
      }
      continue;
    }
    const retryAfter = (fails: number) => now + BACKOFF_S[Math.min(fails, BACKOFF_S.length) - 1]! * 1000;
    if (t.pid) {
      const err = lastLogError(t.name) ?? "ssh exited";
      const fails = t.fails + 1;
      updateTunnel(t.id, { pid: null, via: null, started_at: null, fails, last_error: err, next_retry_at: retryAfter(fails) });
      if (t.desired === "up") addEvent(t.id, "drop", err);
      continue;
    }
    if (t.desired !== "up" || now < t.next_retry_at || !routeFor(t, ts)) continue;
    const res = startTunnel(t.id, ts, sc);
    if (res.ok) {
      if (t.fails) updateTunnel(t.id, { restarts: t.restarts + 1 });
    } else {
      const fails = t.fails + 1;
      updateTunnel(t.id, { fails, next_retry_at: retryAfter(fails) });
    }
  }
}

// ── definitions ─────────────────────────────────────────────────────────────

const SERVICES: Record<number, string> = {
  22: "ssh", 80: "http", 443: "https", 1433: "mssql", 3000: "http", 3306: "mysql", 5432: "postgres",
  5672: "rabbitmq", 6379: "redis", 8080: "http", 8123: "clickhouse", 9200: "elastic", 27017: "mongo",
};

export const inferService = (port: number) => SERVICES[port] ?? null;

export function nextFreePort(sc: Scan): number {
  const used = new Set(listTunnels().map((t) => t.local_port));
  let p = Math.max(17600, ...used) + (used.size ? 1 : 0);
  while (used.has(p) || sc.listeners.has(p)) p++;
  return p;
}

/** A host belongs to the active tailnet when ssh would resolve it through MagicDNS. */
export async function detectTailnet(dest: string, ts: TsState): Promise<string | null> {
  if (!ts.active || !findPeer(ts, bareHost(dest))) return null;
  const r = await resolveHost(dest);
  return r && !r.alias ? ts.active.tailnet : null;
}

export interface TunnelInput {
  name: string;
  host: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
  service?: string | null;
  tailnet?: string | null;
  fallback?: string | null;
  note?: string | null;
}

export function validate(input: TunnelInput, editingId?: number): string | null {
  const port = (n: number) => Number.isInteger(n) && n > 0 && n < 65536;
  if (!/^[\w.-]+$/.test(input.name)) return "name may only contain letters, digits, . _ -";
  if (!/^[^\s@]+(@[^\s@]+)?$/.test(input.host) || input.host.startsWith("-")) return "host must look like [user@]host";
  if (input.fallback && (/\s/.test(input.fallback) || input.fallback.startsWith("-"))) return "fallback must look like [user@]host";
  if (!port(input.local_port)) return "local port must be 1-65535";
  if (!port(input.remote_port)) return "remote port must be 1-65535";
  if (!input.remote_host || /\s/.test(input.remote_host)) return "remote host is required";
  for (const t of listTunnels()) {
    if (t.id === editingId) continue;
    if (t.name === input.name) return `a tunnel named ${t.name} already exists`;
    if (t.local_port === input.local_port) return `local port ${t.local_port} is already assigned to ${t.name}`;
  }
  return null;
}

export function createTunnel(input: TunnelInput): Tunnel {
  const err = validate(input);
  if (err) throw new Error(err);
  return insertTunnel({ ...input, service: input.service || inferService(input.remote_port) });
}

/** Applies an edit, restarting the tunnel when the change affects its ssh process. */
export async function editTunnel(id: number, input: TunnelInput): Promise<{ restarted: boolean }> {
  const err = validate(input, id);
  if (err) throw new Error(err);
  const old = getTunnel(id)!;
  const rewired = (["host", "local_port", "remote_host", "remote_port", "tailnet", "fallback"] as const).some(
    (k) => (old[k] ?? null) !== (input[k] ?? null),
  );
  // stop the old process while the row still describes it, or it would be orphaned
  if (rewired) await killTunnel(old, await scan());
  updateTunnel(id, { ...input });
  const restarted = rewired && old.desired === "up";
  if (restarted) await bringUp(id);
  return { restarted };
}

/** Registers ssh -L processes that are already running outside tnl. */
export async function importRunning(): Promise<{ added: Tunnel[]; notes: string[] }> {
  const [sc, ts] = await Promise.all([scan(), tsState()]);
  const added: Tunnel[] = [];
  const notes: string[] = [];
  for (const proc of sc.procs) {
    if (!proc.dest) continue;
    const known = listTunnels();
    for (const f of proc.forwards) {
      if (known.some((t) => t.local_port === f.lport)) continue;
      const service = inferService(f.rport);
      const base = `${bareHost(proc.dest).split(".")[0]}-${service ?? f.lport}`;
      let name = base;
      for (let i = 2; getTunnelByName(name); i++) name = `${base}-${i}`;
      const tailnet = await detectTailnet(proc.dest, ts);
      const row: NewTunnel = {
        name, host: proc.dest, local_port: f.lport, remote_host: f.rhost, remote_port: f.rport, service, tailnet,
        desired: "up", pid: proc.pid, via: tailnet ? "tailnet" : "direct", started_at: Date.now() - proc.etimeMs,
      };
      const t = insertTunnel(row);
      addEvent(t.id, "import", `from running pid ${proc.pid}`);
      added.push(t);
    }
    if (proc.forwards.length > 1) {
      notes.push(`pid ${proc.pid} carries ${proc.forwards.length} forwards in one ssh process: stopping one stops them all until restarted`);
    }
  }
  return { added, notes };
}
