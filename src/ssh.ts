import { closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Tunnel } from "./db";
import { logPath } from "./paths";

export interface Forward {
  lport: number;
  rhost: string;
  rport: number;
}

export interface SshProc {
  pid: number;
  etimeMs: number;
  cmd: string;
  dest: string | null;
  forwards: Forward[];
}

export interface Listener {
  pid: number;
  command: string;
}

export interface Scan {
  procs: SshProc[];
  listeners: Map<number, Listener>;
}

async function capture(cmd: string[], timeoutMs = 5000): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: timeoutMs });
    const out = await proc.stdout.text();
    await proc.exited;
    return out;
  } catch {
    return "";
  }
}

export function parseForward(spec: string): Forward | null {
  // [bind_address:]port:host:hostport — host may be a bracketed IPv6 literal
  const m = spec.match(/^(?:.*:)?(\d+):(\[[^\]]+\]|[^:]+):(\d+)$/);
  if (!m) return null;
  return { lport: Number(m[1]), rhost: m[2]!, rport: Number(m[3]) };
}

// ssh(1) flags that consume the following argument
const FLAGS_WITH_ARG = "BbcDEeFIiJLlmOoPpQRSWw";

export function parseSshCommand(cmd: string): { dest: string | null; forwards: Forward[] } | null {
  const tok = cmd.trim().split(/\s+/);
  if (!tok[0] || !/(^|\/)ssh$/.test(tok[0])) return null;
  let dest: string | null = null;
  let login: string | null = null;
  const forwards: Forward[] = [];
  for (let i = 1; i < tok.length; i++) {
    const a = tok[i]!;
    if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const f = a[j]!;
        if (!FLAGS_WITH_ARG.includes(f)) continue;
        const val = j + 1 < a.length ? a.slice(j + 1) : (tok[++i] ?? "");
        if (f === "L") {
          const fw = parseForward(val);
          if (fw) forwards.push(fw);
        } else if (f === "l") login = val;
        break;
      }
    } else if (!dest) {
      dest = a; // ssh keeps reading options after the destination
    } else {
      break; // second bare word starts the remote command
    }
  }
  if (dest && login && !dest.includes("@")) dest = `${login}@${dest}`;
  return { dest, forwards };
}

function parseEtime(s: string): number {
  // [[dd-]hh:]mm:ss
  const [rest, days] = s.includes("-") ? [s.split("-")[1]!, Number(s.split("-")[0])] : [s, 0];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return (((days * 24 + parts[0]!) * 60 + parts[1]!) * 60 + parts[2]!) * 1000;
}

/** One pass over running ssh port-forwards and every listening TCP port. */
export async function scan(): Promise<Scan> {
  const [ps, listeners] = await Promise.all([capture(["ps", "-axo", "pid=,etime=,args="]), scanListeners()]);

  const procs: SshProc[] = [];
  for (const line of ps.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const parsed = parseSshCommand(m[3]!);
    if (!parsed || !parsed.forwards.length) continue;
    procs.push({ pid: Number(m[1]), etimeMs: parseEtime(m[2]!), cmd: m[3]!, ...parsed });
  }

  return { procs, listeners };
}

/** `ss -ltnpH` lines: `LISTEN 0 128 127.0.0.1:17600 0.0.0.0:* users:(("ssh",pid=123,fd=5))`. */
export function parseSs(out: string): Map<number, Listener> {
  const listeners = new Map<number, Listener>();
  for (const line of out.split("\n")) {
    const m = line.match(/^LISTEN\s+\d+\s+\d+\s+\S*:(\d+)\s+\S+\s*(?:users:\(\("([^"]*)",pid=(\d+))?/);
    if (!m) continue;
    const port = Number(m[1]);
    // sockets of other users come without process info; the port is still taken
    if (!listeners.has(port) || m[3]) listeners.set(port, { pid: Number(m[3] ?? 0), command: m[2] ?? "another user's process" });
  }
  return listeners;
}

/** `lsof -F pcn` output: one `p<pid>`, `c<command>` then `n<addr:port>` per socket. */
export function parseLsof(out: string): Map<number, Listener> {
  const listeners = new Map<number, Listener>();
  let pid = 0;
  let command = "";
  for (const line of out.split("\n")) {
    const v = line.slice(1);
    if (line[0] === "p") pid = Number(v);
    else if (line[0] === "c") command = v;
    else if (line[0] === "n") {
      const port = Number(v.slice(v.lastIndexOf(":") + 1));
      if (port && !listeners.has(port)) listeners.set(port, { pid, command });
    }
  }
  return listeners;
}

const useSs = process.platform === "linux" && !!Bun.which("ss");

async function scanListeners(): Promise<Map<number, Listener>> {
  // ss ships with every Linux distro (iproute2); lsof is the one macOS has
  return useSs ? parseSs(await capture(["ss", "-ltnpH"])) : parseLsof(await capture(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]));
}

export function sshArgs(t: Pick<Tunnel, "local_port" | "remote_host" | "remote_port">, dest: string): string[] {
  return [
    "-N",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=10",
    // tunnels run unattended: never block on a password or host-key prompt
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-L", `${t.local_port}:${t.remote_host}:${t.remote_port}`,
    dest,
  ];
}

/** Starts ssh in its own session so it outlives this process. Returns the pid. */
export function spawnTunnel(t: Tunnel, dest: string): number {
  const args = sshArgs(t, dest);
  const fd = openSync(logPath(t.name), "a");
  try {
    writeSync(fd, `--- ${new Date().toISOString()} ssh ${args.join(" ")}\n`);
    const proc = Bun.spawn(["ssh", ...args], { stdin: "ignore", stdout: fd, stderr: fd, detached: true });
    proc.unref();
    return proc.pid;
  } finally {
    closeSync(fd);
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function killPid(pid: number) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(100);
    if (!pidAlive(pid)) return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

export function logTail(name: string, lines: number): string[] {
  try {
    const all = readFileSync(logPath(name), "utf8").trimEnd().split("\n");
    return all.slice(-lines);
  } catch {
    return [];
  }
}

/** The last thing ssh said since the most recent start, if anything. */
export function lastLogError(name: string): string | null {
  const tail = logTail(name, 30);
  for (let i = tail.length - 1; i >= 0; i--) {
    const l = tail[i]!.trim();
    if (l.startsWith("--- ")) return null;
    if (l && !l.startsWith("Warning: Permanently added")) return l;
  }
  return null;
}

export interface Resolved {
  hostname: string;
  user: string;
  port: number;
  /** true when ~/.ssh/config rewrites the name (so it does not rely on MagicDNS) */
  alias: boolean;
}

/** Asks ssh itself how it would resolve a destination — no config parsing of our own. */
export async function resolveHost(dest: string): Promise<Resolved | null> {
  const out = await capture(["ssh", "-G", dest]);
  if (!out) return null;
  const get = (k: string) => out.match(new RegExp(`^${k} (.*)$`, "m"))?.[1] ?? "";
  const bare = dest.slice(dest.indexOf("@") + 1).toLowerCase();
  const hostname = get("hostname");
  return { hostname, user: get("user"), port: Number(get("port")) || 22, alias: hostname.toLowerCase() !== bare };
}

export interface ConfigHost {
  name: string;
  hostName: string | null;
  user: string | null;
  port: string | null;
}

/** Lists concrete `Host` entries from ~/.ssh/config (following Include) for the picker. */
export function configHosts(file = join(homedir(), ".ssh", "config"), depth = 0): ConfigHost[] {
  if (depth > 3 || !existsSync(file)) return [];
  const hosts: ConfigHost[] = [];
  let current: ConfigHost[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\S+?)(?:\s*=\s*|\s+)(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim().replace(/^"(.*)"$/, "$1");
    if (key === "include") {
      for (const pat of val.split(/\s+/)) {
        const p = pat.replace(/^~/, homedir());
        const full = isAbsolute(p) ? p : join(dirname(file), p);
        const paths = full.includes("*") ? [...new Bun.Glob(full).scanSync({ absolute: true })] : [full];
        for (const f of paths) hosts.push(...configHosts(f, depth + 1));
      }
    } else if (key === "host") {
      current = val
        .split(/\s+/)
        .filter((n) => !/[*?!]/.test(n))
        .map((name) => ({ name, hostName: null, user: null, port: null }));
      hosts.push(...current);
    } else if (key === "match") current = [];
    else if (key === "hostname") current.forEach((h) => (h.hostName ??= val));
    else if (key === "user") current.forEach((h) => (h.user ??= val));
    else if (key === "port") current.forEach((h) => (h.port ??= val));
  }
  return hosts;
}
