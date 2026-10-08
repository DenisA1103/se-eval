import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Wurzelverzeichnis des Tools (enthält package.json und configs/), egal ob aus src/ oder dist/ gestartet. */
export const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export const TOOL_VERSION: string = (
  JSON.parse(readFileSync(join(TOOL_DIR, "package.json"), "utf8")) as { version: string }
).version;
