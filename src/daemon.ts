import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { clearHeartbeat, daemonInfo, heartbeat, reconcile } from "./core";
import { HOME, LOG_DIR } from "./paths";
import { tsState } from "./tailscale";

const LABEL = "dev.tnl.supervisor";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const TICK_MS = 3000;

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

// ── launchd ─────────────────────────────────────────────────────────────────

const domain = () => `gui/${process.getuid?.() ?? 501}`;

async function launchctl(...args: string[]) {
  const proc = Bun.spawn(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { ok: code === 0, out, err: err.trim() };
}

/** How launchd should start us: the compiled binary, or `bun <script>` when run from source. */
function selfCommand(): string[] {
  return Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main];
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plist(): string {
  const env: Record<string, string> = {
    PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  if (process.env.TNL_HOME) env.TNL_HOME = process.env.TNL_HOME;
  // launchd provides the system ssh-agent socket itself; only pin a custom agent (1Password, etc.)
  const sock = process.env.SSH_AUTH_SOCK;
  if (sock && !sock.includes("com.apple.launchd")) env.SSH_AUTH_SOCK = sock;
  const strings = (xs: string[]) => xs.map((x) => `    <string>${xml(x)}</string>`).join("\n");
  const logFile = xml(join(LOG_DIR, "daemon.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings([...selfCommand(), "daemon", "run"])}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
</dict>
</plist>
`;
}

export async function installDaemon(): Promise<string> {
  if (process.platform !== "darwin") throw new Error("launchd install is macOS only; run `tnl daemon run` under your own service manager");
  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(PLIST, plist());
  await bootout();
  const res = await launchctl("bootstrap", domain(), PLIST);
  if (!res.ok) throw new Error(`launchctl bootstrap failed: ${res.err}`);
  return PLIST;
}

/** Unloads the agent and waits for launchd to finish; bootstrap fails with EIO if it is still going. */
async function bootout() {
  const target = `${domain()}/${LABEL}`;
  await launchctl("bootout", target);
  for (let i = 0; i < 50 && (await launchctl("print", target)).ok; i++) await Bun.sleep(100);
}

export async function uninstallDaemon(): Promise<boolean> {
  await bootout();
  if (!existsSync(PLIST)) return false;
  unlinkSync(PLIST);
  return true;
}

export async function daemonStatus() {
  const loaded = process.platform === "darwin" && (await launchctl("print", `${domain()}/${LABEL}`)).ok;
  return { installed: existsSync(PLIST), loaded, plist: PLIST, log: join(LOG_DIR, "daemon.log"), ...daemonInfo() };
}
