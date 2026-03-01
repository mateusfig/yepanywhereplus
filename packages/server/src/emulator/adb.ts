import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const isWindows = os.platform() === "win32";

/**
 * Detect adb: check PATH first, then common Android SDK locations.
 * Returns the path to adb, or null if not found.
 */
export function detectAdb(): string | null {
  // Try PATH first
  const cmd = isWindows ? "where adb" : "which adb";
  try {
    const result = execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .split("\n")[0]
      ?.trim();
    if (result) return result;
  } catch {
    // Not on PATH, try SDK locations
  }

  // Check common Android SDK locations
  const home = os.homedir();
  const candidates = isWindows
    ? [
        path.join(home, "AppData", "Local", "Android", "Sdk", "platform-tools", "adb.exe"),
        path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk", "platform-tools", "adb.exe"),
      ]
    : [
        path.join(home, "Android", "Sdk", "platform-tools", "adb"),
        path.join(home, "Library", "Android", "sdk", "platform-tools", "adb"),
        "/opt/android-sdk/platform-tools/adb",
      ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}
