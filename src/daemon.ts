import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { clearHeartbeat, daemonInfo, heartbeat, reconcile } from "./core";
import { HOME, LOG_DIR } from "./paths";
import { tsState } from "./tailscale";

const TICK_MS = 3000;
const LOG_FILE = join(LOG_DIR, "daemon.log");

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

/** Foreground supervisor loop. Tunnels are separate sessions and keep running if this exits. */
export async function runDaemon() {
  const other = daemonInfo();
  if (other.alive && other.pid !== process.pid) {
    console.error(`supervisor already running (pid ${other.pid})`);
    process.exit(0);
  }
  const quit = () => {
    clearHeartbeat();
    log("supervisor stopped");
    process.exit(0);
  };
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);
  log(`supervisor started, pid ${process.pid}, data ${HOME}`);
  let seen = "";
  for (;;) {
    try {
      heartbeat();
      await reconcile();
      const ts = await tsState();
      const now = ts.available ? `tailscale ${ts.backend || "unreachable"}, account ${ts.active?.tailnet ?? "none"}${ts.error ? ` (${ts.error})` : ""}` : "tailscale CLI not found";
      if (now !== seen) log((seen = now));
    } catch (e) {
      log(`reconcile failed: ${e instanceof Error ? e.message : e}`);
    }
    await Bun.sleep(TICK_MS);
  }
}

// ── service managers ────────────────────────────────────────────────────────

async function sh(...cmd: string[]) {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { ok: code === 0, out: out.trim(), err: err.trim() };
  } catch (e) {
    return { ok: false, out: "", err: String(e) };
  }
}

/** How the service manager should start us: the compiled binary, or `bun <script>` when run from source. */
function selfCommand(): string[] {
  if (!Bun.main.startsWith("/$bunfs/")) return [process.execPath, Bun.main];
  // Homebrew keeps each version in its own Cellar directory; point at the stable symlink so upgrades don't break the service
  const linked = process.execPath.replace(/\/Cellar\/tnl\/[^/]+\/bin\/tnl$/, "/bin/tnl");
  return [existsSync(linked) ? linked : process.execPath];
}

function serviceEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: [...new Set([dirname(selfCommand()[0]!), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":"),
  };
  if (process.env.TNL_HOME) env.TNL_HOME = process.env.TNL_HOME;
  // Pin the ssh-agent socket only when its path is stable. macOS launchd supplies its own agent,
  // and sockets under /tmp belong to one login session (forwarded agents) and would go stale.
  const sock = process.env.SSH_AUTH_SOCK;
  if (sock && !sock.includes("com.apple.launchd") && !sock.startsWith("/tmp/")) env.SSH_AUTH_SOCK = sock;
  return env;
}

interface Manager {
  name: string;
  /** the unit / plist file */
  file: string;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  loaded(): Promise<boolean>;
}

// ── launchd (macOS) ─────────────────────────────────────────────────────────

const LABEL = "dev.tnl.supervisor";
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const launchd: Manager = (() => {
  const file = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  const target = () => `gui/${process.getuid?.() ?? 501}/${LABEL}`;
  const plist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[...selfCommand(), "daemon", "run"].map((x) => `    <string>${xml(x)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(serviceEnv()).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(LOG_FILE)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG_FILE)}</string>
</dict>
</plist>
`;
  /** Unloads the agent and waits for launchd to finish; bootstrap fails with EIO if it is still going. */
  const bootout = async () => {
    await sh("launchctl", "bootout", target());
    for (let i = 0; i < 50 && (await sh("launchctl", "print", target())).ok; i++) await Bun.sleep(100);
  };
  return {
    name: "launchd",
    file,
    async install() {
      writeFileSync(file, plist());
      await bootout();
      const res = await sh("launchctl", "bootstrap", target().slice(0, target().lastIndexOf("/")), file);
      if (!res.ok) throw new Error(`launchctl bootstrap failed: ${res.err}`);
    },
    uninstall: bootout,
    loaded: async () => (await sh("launchctl", "print", target())).ok,
  };
})();

// ── systemd user service (Linux) ────────────────────────────────────────────

const UNIT = "tnl-supervisor.service";
const quote = (s: string) => (/[\s"\\]/.test(s) ? `"${s.replace(/(["\\])/g, "\\$1")}"` : s);

const systemd: Manager = (() => {
  const file = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", UNIT);
  const unit = () => `[Unit]
Description=tnl tunnel supervisor
After=network-online.target

[Service]
ExecStart=${[...selfCommand(), "daemon", "run"].map(quote).join(" ")}
${Object.entries(serviceEnv()).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`).join("\n")}
Restart=always
RestartSec=3
# stop only the supervisor: tunnels live in the same cgroup and must survive restarts
KillMode=process
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=default.target
`;
  const ctl = (...args: string[]) => sh("systemctl", "--user", ...args);
  return {
    name: "systemd",
    file,
    async install() {
      writeFileSync(file, unit());
      await ctl("daemon-reload");
      const enable = await ctl("enable", UNIT);
      const start = await ctl("restart", UNIT);
      const failed = [enable, start].find((r) => !r.ok);
      if (failed) throw new Error(`systemctl --user failed: ${failed.err || "is a systemd user session available?"}`);
    },
    async uninstall() {
      await ctl("disable", "--now", UNIT);
      await ctl("daemon-reload");
    },
    loaded: async () => (await ctl("is-active", UNIT)).ok,
  };
})();

function manager(): Manager {
  if (process.platform === "darwin") return launchd;
  if (process.platform === "linux" && Bun.which("systemctl")) return systemd;
  throw new Error("no supported service manager here (launchd or systemd); run `tnl daemon run` under your own");
}

export async function installDaemon(): Promise<string> {
  const m = manager();
  mkdirSync(dirname(m.file), { recursive: true });
  await m.install();
  return m.file;
}

export async function uninstallDaemon(): Promise<boolean> {
  const m = manager();
  await m.uninstall();
  if (!existsSync(m.file)) return false;
  unlinkSync(m.file);
  return true;
}

export async function daemonStatus() {
  let service: { manager: string; file: string; installed: boolean; loaded: boolean } | null = null;
  try {
    const m = manager();
    service = { manager: m.name, file: m.file, installed: existsSync(m.file), loaded: await m.loaded() };
  } catch {}
  return { service, log: LOG_FILE, ...daemonInfo() };
}
