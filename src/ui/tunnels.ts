import type { View } from "../core";
import { bold, cyan, dim, fmtDuration, gray, green, statusBadge, statusColor, yellow, type Col } from "./ansi";

export const TUNNEL_COLS: Col[] = [
  { title: "STATUS", min: 10 },
  { title: "NAME", min: 8, max: 28 },
  { title: "SERVICE", min: 7, max: 12, drop: 2 },
  { title: "LOCAL", min: 5, right: true },
  { title: "REMOTE", min: 14, max: 46 },
  { title: "TAILNET", min: 7, max: 18, drop: 3 },
  { title: "UPTIME", min: 6, right: true, drop: 1 },
  { title: "INFO", min: 10, grow: true, drop: 4 },
];

function info(v: View): string {
  if (v.detail) return statusColor(v.status)(v.detail);
  if (v.status === "up" && v.restarts) return dim(`${v.restarts} restart${v.restarts === 1 ? "" : "s"}`);
  return dim(v.note ?? "");
}

function tailnet(v: View): string {
  if (!v.tailnet) return dim("—");
  if (v.via === "fallback" || (!v.via && v.route?.via === "fallback")) return yellow(`${v.tailnet} ↪`);
  return v.route?.via === "tailnet" ? green(v.tailnet) : gray(v.tailnet);
}

export function tunnelCells(v: View): string[] {
  const dest = v.route?.via === "fallback" ? v.route.dest : v.host;
  return [
    statusBadge(v.status),
    bold(v.name),
    v.service ?? "",
    cyan(String(v.local_port)),
    `${dest} ${dim("→")} ${v.remote_host}:${v.remote_port}`,
    tailnet(v),
    fmtDuration(v.uptimeMs),
    info(v),
  ];
}

export function summary(views: View[]): string {
  const n = (s: View["status"][]) => views.filter((v) => s.includes(v.status)).length;
  const parts = [
    [n(["up"]), green, "up"],
    [n(["starting", "retrying"]), yellow, "connecting"],
    [n(["dropped", "blocked"]), statusColor("dropped"), "need attention"],
    [n(["down"]), gray, "down"],
  ] as const;
  return parts.filter(([c]) => c).map(([c, color, label]) => color(`${c} ${label}`)).join(dim(" · "));
}
