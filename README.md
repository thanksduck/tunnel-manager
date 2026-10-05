# tnl — tunnel manager

A Tailscale-aware manager for `ssh -L` tunnels, with a live terminal dashboard and a
background supervisor that reconnects tunnels when they drop. Built on Bun with no
runtime dependencies.

Instead of one terminal window per `ssh root@host -N -L 17600:localhost:5432`, every
tunnel is a named entry in a SQLite database. `tnl` shows which machine each local port
is bound to, which service it is, whether it is up, and why it is not.

## Install

Requires [Bun](https://bun.sh) 1.4+ to build, and macOS for the launchd supervisor.

```bash
bun install
bun run install-bin      # compiles a single binary to ~/.local/bin/tnl
tnl daemon install       # optional: auto-reconnect and start at login
```

## Use

```bash
tnl                      # dashboard
tnl import               # adopt ssh -L processes that are already running
tnl add wellvibe-db root@wellvibe 17600:5432 --up
tnl ls
tnl down wellvibe-db
tnl logs wellvibe-db
tnl ts                   # Tailscale accounts and machines
tnl ts switch Mainnet    # shows which tunnels will drop first
tnl --help
```

### Dashboard keys

| Key | Action |
| --- | --- |
| `↑` `↓` / `j` `k` / wheel | select |
| `enter` / double-click | start or stop the tunnel |
| `r` `e` `d` `l` | restart, edit, delete, logs |
| `a` | add a tunnel |
| `i` | import running `ssh -L` processes |
| `tab` | Machines view: Tailscale accounts, peers and `~/.ssh/config` hosts. `enter` on an account switches to it; on a machine it opens a pre-filled new-tunnel form |
| `q` | quit (tunnels keep running) |

Header tabs, rows, footer keys and dialog buttons are all clickable.

## How it works

- **Tunnels are plain `ssh` processes** started in their own session with
  `ExitOnForwardFailure`, `ServerAliveInterval=15` and `BatchMode`, so a dead connection
  exits within ~45 seconds instead of hanging. They survive `tnl` and the supervisor exiting.
- **State is observed, not assumed.** Each refresh reads `ps` and `lsof` to see which ssh
  process really holds which local port, so a tunnel killed from outside shows as dropped.
- **Supervisor** (`tnl daemon install`) is a launchd agent that checks every 3 seconds and
  restarts wanted tunnels with backoff (2s → 60s). Every start and drop is recorded and
  shown in `tnl logs`.
- **Tailscale.** Only one Tailscale account can be active at a time. A tunnel whose host
  is resolved through MagicDNS is tagged with its tailnet (from `tailscale switch --list`
  and `tailscale status --json`). Starting it while another account is active asks before
  switching and lists the tunnels that would drop. Those stay wanted and come back when
  you switch back. Set a `fallback` ssh host (for example a public-IP alias from
  `~/.ssh/config`) to keep a tunnel reachable without switching.
- **SSH config** is never re-implemented: `ssh -G <host>` is asked how a name resolves.

## Tunnel states

| State | Meaning |
| --- | --- |
| `● up` | ssh is running and listening on the local port |
| `◐ starting` / `◐ retrying` | connecting, or waiting for the supervisor's next attempt |
| `✖ dropped` | wanted but not running, and no supervisor to restart it |
| `⊘ blocked` | its tailnet is not the active account and it has no fallback |
| `○ down` | stopped on purpose |

## Files

| Path | Contents |
| --- | --- |
| `~/.tunnel-manager/tunnels.db` | tunnel definitions, state and history (SQLite) |
| `~/.tunnel-manager/logs/<name>.log` | ssh output per tunnel |
| `~/.tunnel-manager/logs/daemon.log` | supervisor log |
| `~/Library/LaunchAgents/dev.tnl.supervisor.plist` | launchd agent, if installed |

Set `TNL_HOME` to use a different data directory.

## Limits

- Local forwards (`-L`) only; no `-R` or `-D`.
- Tunnels run with `BatchMode=yes`, so keys must work without a prompt (agent or
  passphrase-less key). A host that needs a password will show as dropped with ssh's error.
- An imported ssh process that carries several `-L` forwards becomes several entries
  sharing one process: stopping one stops them all until they are restarted separately.

## Development

```bash
bun src/cli.ts           # run from source
bun run typecheck
TNL_HOME=/tmp/tnl-test bun src/cli.ts ls   # scratch database
```
