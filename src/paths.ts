import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = process.env.TNL_HOME ?? join(homedir(), ".tunnel-manager");
export const DB_PATH = join(HOME, "tunnels.db");
export const LOG_DIR = join(HOME, "logs");

mkdirSync(LOG_DIR, { recursive: true });

export const logPath = (name: string) => join(LOG_DIR, `${name}.log`);
