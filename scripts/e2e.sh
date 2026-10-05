#!/usr/bin/env bash
# End-to-end check against a real sshd on localhost:
# start a tunnel, pass traffic, kill it, let the supervisor reconnect, stop, import.
# Usage: scripts/e2e.sh <path-to-tnl>   (CI only: it enables key login to this machine)
set -euo pipefail

TNL=$(realpath "${1:?path to the tnl binary}")
export TNL_HOME=$(mktemp -d)
ME="$(id -un)@127.0.0.1"
WEB=18080 LOCAL=18081 MANUAL=18082

step() { printf '\n== %s\n' "$*"; }
field() { "$TNL" ls --json | python3 -c "import json,sys; print(next(t for t in json.load(sys.stdin) if t['name']=='$1')['$2'])"; }
expect() { local got; got=$(field "$1" "$2"); [ "$got" = "$3" ] || { echo "FAIL: $1.$2 is '$got', expected '$3'"; "$TNL" ls; "$TNL" logs "$1" || true; exit 1; }; }
fetch() { curl -fsS --max-time 3 "http://127.0.0.1:$1/" >/dev/null; }
cleanup() { "$TNL" down all >/dev/null 2>&1 || true; pkill -f "ssh .*-L $MANUAL:" 2>/dev/null || true; kill $(jobs -p) 2>/dev/null || true; }
trap cleanup EXIT

step "sshd with key login on localhost"
if ! command -v sshd >/dev/null; then sudo apt-get update -qq && sudo apt-get install -y -qq openssh-server; fi
sudo systemctl start ssh 2>/dev/null || sudo systemctl start sshd
mkdir -p ~/.ssh && chmod 700 ~/.ssh
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
chmod go-w ~

step "target service"
python3 -m http.server "$WEB" --bind 127.0.0.1 >/dev/null 2>&1 &
sleep 1 && fetch "$WEB"

step "add and start"
"$TNL" add web "$ME" "$LOCAL:$WEB" --tailnet none --up
expect web status up
fetch "$LOCAL"
echo "traffic flows through localhost:$LOCAL"

step "runs detached from this shell"
pid=$(field web pid)
if [ "$(ps -o sid= -p "$pid" | tr -d ' ')" = "$(ps -o sid= -p $$ | tr -d ' ')" ]; then echo "FAIL: ssh shares this shell's session"; exit 1; fi
echo "ssh pid $pid has its own session"

step "drop is detected"
kill "$pid"
sleep 1
expect web status dropped

step "supervisor reconnects"
"$TNL" daemon run &
for i in $(seq 1 20); do sleep 1; fetch "$LOCAL" 2>/dev/null && break; done
expect web status up
expect web restarts 1
"$TNL" logs web -n 3

step "stop"
"$TNL" down web
expect web status down
if fetch "$LOCAL" 2>/dev/null; then echo "FAIL: port $LOCAL still forwards after down"; exit 1; fi

step "import a tunnel started by hand with ssh -f"
ssh -f -N -o BatchMode=yes -o StrictHostKeyChecking=accept-new -L "$MANUAL:127.0.0.1:$WEB" "$ME"
"$TNL" import
name=$("$TNL" ls --json | python3 -c "import json,sys; print(next(t['name'] for t in json.load(sys.stdin) if t['local_port']==$MANUAL))")
expect "$name" status up
"$TNL" down "$name"
if pgrep -f "ssh .*-L $MANUAL:" >/dev/null; then echo "FAIL: imported ssh still running after down"; exit 1; fi

step "final state"
"$TNL" ls
echo; echo "e2e passed"
