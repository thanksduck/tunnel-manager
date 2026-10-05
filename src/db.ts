import { Database } from "bun:sqlite";
import { DB_PATH } from "./paths";

export type Via = "tailnet" | "fallback" | "direct";

export interface Tunnel {
  id: number;
  name: string;
  /** ssh destination as typed: `[user@]host` */
  host: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
  service: string | null;
  /** tailnet this host lives on; null = reachable without Tailscale */
  tailnet: string | null;
  /** ssh destination to use when `tailnet` is not the active account */
  fallback: string | null;
  note: string | null;
  desired: "up" | "down";
  pid: number | null;
  via: Via | null;
  started_at: number | null;
  fails: number;
  restarts: number;
  next_retry_at: number;
  last_error: string | null;
  created_at: number;
}

export interface TunnelEvent {
  id: number;
  tunnel_id: number;
  ts: number;
  kind: string;
  msg: string;
}

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS tunnels (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    host          TEXT NOT NULL,
    local_port    INTEGER NOT NULL UNIQUE,
    remote_host   TEXT NOT NULL DEFAULT 'localhost',
    remote_port   INTEGER NOT NULL,
    service       TEXT,
    tailnet       TEXT,
    fallback      TEXT,
    note          TEXT,
    desired       TEXT NOT NULL DEFAULT 'down',
    pid           INTEGER,
    via           TEXT,
    started_at    INTEGER,
    fails         INTEGER NOT NULL DEFAULT 0,
    restarts      INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    tunnel_id INTEGER NOT NULL REFERENCES tunnels(id) ON DELETE CASCADE,
    ts        INTEGER NOT NULL,
    kind      TEXT NOT NULL,
    msg       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_tunnel ON events(tunnel_id, id DESC);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

export const listTunnels = () =>
  db.query<Tunnel, []>("SELECT * FROM tunnels ORDER BY name").all();

export const getTunnel = (id: number) =>
  db.query<Tunnel, [number]>("SELECT * FROM tunnels WHERE id = ?").get(id);

export const getTunnelByName = (name: string) =>
  db.query<Tunnel, [string]>("SELECT * FROM tunnels WHERE name = ?").get(name);

export type NewTunnel = Pick<Tunnel, "name" | "host" | "local_port" | "remote_host" | "remote_port"> &
  Partial<Pick<Tunnel, "service" | "tailnet" | "fallback" | "note" | "desired" | "pid" | "via" | "started_at">>;

export function insertTunnel(t: NewTunnel): Tunnel {
  const row = { created_at: Date.now(), ...t };
  const keys = Object.keys(row);
  const res = db
    .query(`INSERT INTO tunnels (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
    .run(...(Object.values(row) as (string | number | null)[]));
  return getTunnel(Number(res.lastInsertRowid))!;
}

export function updateTunnel(id: number, patch: Partial<Omit<Tunnel, "id">>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.query(`UPDATE tunnels SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
    ...(Object.values(patch) as (string | number | null)[]),
    id,
  );
}

export const deleteTunnel = (id: number) => db.query("DELETE FROM tunnels WHERE id = ?").run(id);

export function addEvent(tunnelId: number, kind: string, msg: string) {
  db.query("INSERT INTO events (tunnel_id, ts, kind, msg) VALUES (?, ?, ?, ?)").run(tunnelId, Date.now(), kind, msg);
  db.query(
    "DELETE FROM events WHERE tunnel_id = ?1 AND id NOT IN (SELECT id FROM events WHERE tunnel_id = ?1 ORDER BY id DESC LIMIT 200)",
  ).run(tunnelId);
}

export const listEvents = (tunnelId: number, limit = 20) =>
  db
    .query<TunnelEvent, [number, number]>("SELECT * FROM events WHERE tunnel_id = ? ORDER BY id DESC LIMIT ?")
    .all(tunnelId, limit);

export const getMeta = (key: string) =>
  db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;

export const setMeta = (key: string, value: string) =>
  db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
