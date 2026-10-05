import { existsSync } from "node:fs";

export interface Profile {
  id: string;
  tailnet: string;
  account: string;
  active: boolean;
}

export interface Peer {
  /** first label of the MagicDNS name — what you type after `ssh` */
  label: string;
  hostName: string;
  dns: string;
  ip: string;
  os: string;
  online: boolean;
  self: boolean;
}

export interface TsState {
  available: boolean;
  running: boolean;
  backend: string;
  profiles: Profile[];
  active: Profile | null;
  peers: Peer[];
  error: string | null;
}

const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

let bin: string | null | undefined;
export function tsBin(): string | null {
  if (bin !== undefined) return bin;
  bin = Bun.which("tailscale") ?? (existsSync(MAC_APP_CLI) ? MAC_APP_CLI : null);
  return bin;
}

async function run(args: string[], timeoutMs = 6000) {
  const b = tsBin();
  if (!b) return { ok: false, out: "", err: "tailscale CLI not found" };
  try {
    const proc = Bun.spawn([b, ...args], {
      stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs,
      // without a terminal (launchd) the macOS app binary tries to open the GUI unless told otherwise
      env: { ...process.env, TAILSCALE_BE_CLI: "1" },
    });
    const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { ok: code === 0, out, err: err.trim() };
  } catch (e) {
    return { ok: false, out: "", err: String(e) };
  }
}

/** Parses the fixed-width table printed by `tailscale switch --list`. */
export function parseProfiles(text: string): Profile[] {
  const lines = text.split("\n").filter((l) => l.trim());
  const head = lines.shift();
  if (!head) return [];
  const iT = head.indexOf("Tailnet");
  const iA = head.indexOf("Account");
  if (iT < 0 || iA < 0) return [];
  return lines.map((l) => {
    const account = l.slice(iA).trim();
    const active = account.endsWith("*");
    return {
      id: l.slice(0, iT).trim(),
      tailnet: l.slice(iT, iA).trim(),
      account: active ? account.slice(0, -1) : account,
      active,
    };
  });
}

interface RawPeer {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  OS?: string;
  Online?: boolean;
}

function toPeer(p: RawPeer, self: boolean): Peer {
  const dns = (p.DNSName ?? "").replace(/\.$/, "");
  return {
    label: dns.split(".")[0] || p.HostName || "?",
    hostName: p.HostName ?? "",
    dns,
    ip: p.TailscaleIPs?.[0] ?? "",
    os: p.OS ?? "",
    online: self || !!p.Online,
    self,
  };
}

async function fetchState(): Promise<TsState> {
  const empty: TsState = { available: false, running: false, backend: "", profiles: [], active: null, peers: [], error: null };
  if (!tsBin()) return { ...empty, error: "tailscale CLI not found" };
  const [list, status] = await Promise.all([run(["switch", "--list"]), run(["status", "--json"])]);
  const profiles = list.ok ? parseProfiles(list.out) : [];
  const state: TsState = { ...empty, available: true, profiles, active: profiles.find((p) => p.active) ?? null };
  try {
    const j = JSON.parse(status.out) as { BackendState?: string; Self?: RawPeer; Peer?: Record<string, RawPeer> };
    state.backend = j.BackendState ?? "";
    state.running = state.backend === "Running";
    state.peers = [
      ...(j.Self ? [toPeer(j.Self, true)] : []),
      ...Object.values(j.Peer ?? {}).map((p) => toPeer(p, false)),
    ].sort((a, b) => Number(b.online) - Number(a.online) || a.label.localeCompare(b.label));
  } catch {
    state.error = status.err || "could not read tailscale status";
  }
  return state;
}

const CACHE_MS = 4000;
let cache: { at: number; state: Promise<TsState> } | null = null;

export function tsState(fresh = false): Promise<TsState> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.state;
  cache = { at: Date.now(), state: fetchState() };
  return cache.state;
}

/** Switches account and waits until the new tailnet is connected. */
export async function switchProfile(p: Profile): Promise<TsState> {
  const res = await run(["switch", p.id], 20000);
  if (!res.ok) throw new Error(res.err || `tailscale switch ${p.id} failed`);
  for (let i = 0; i < 30; i++) {
    const s = await tsState(true);
    if (s.running && s.active?.id === p.id) return s;
    await Bun.sleep(500);
  }
  throw new Error(`switched to ${p.tailnet} but Tailscale did not reach Running`);
}

export function findPeer(ts: TsState, host: string): Peer | undefined {
  const h = host.toLowerCase();
  return ts.peers.find((p) => p.label.toLowerCase() === h || p.dns.toLowerCase() === h || p.ip === h);
}
