/**
 * E2E test for physical Android device WebRTC streaming.
 *
 * Requires:
 *   - A connected physical Android device (detected via `adb devices`)
 *   - The device-bridge binary built at packages/device-bridge/bridge
 *
 * Skipped automatically when prerequisites are missing.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_BINARY = resolve(__dirname, "../../device-bridge/bridge");

/** Find adb binary — checks PATH then common Android SDK locations. */
function findAdb(): string | null {
  const candidates = [
    "adb",
    join(homedir(), "Android", "Sdk", "platform-tools", "adb"),
    join(homedir(), "Library", "Android", "sdk", "platform-tools", "adb"),
    "/opt/android-sdk/platform-tools/adb",
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["version"], { timeout: 3000, stdio: "ignore" });
      return candidate;
    } catch {
      // not found or not executable
    }
  }
  return null;
}

function findRunningPhysicalAndroidDevice(): string | null {
  const adb = findAdb();
  if (!adb) return null;

  try {
    const output = execFileSync(adb, ["devices"], { timeout: 5000 }).toString();
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("List of")) continue;

      const fields = trimmed.split(/\s+/);
      if (fields.length < 2 || fields[1] !== "device") continue;

      const serial = fields[0];
      if (!serial.startsWith("emulator-")) {
        return serial;
      }
    }
  } catch {
    // adb query failed
  }

  return null;
}

test("streams physical Android device video over WebRTC when attached", async ({
  page,
  baseURL,
}) => {
  test.slow();
  test.skip(
    !existsSync(BRIDGE_BINARY),
    "device-bridge binary not built — run: cd packages/device-bridge && go build -o bridge ./cmd/bridge/",
  );

  const deviceSerial = findRunningPhysicalAndroidDevice();
  test.skip(
    !deviceSerial,
    "No physical Android device detected — attach a device with USB debugging enabled",
  );

  await page.goto(`${baseURL}/emulator`);

  // Fresh E2E temp dirs can show onboarding modal which blocks clicks.
  const closeOnboarding = page.getByRole("button", { name: "Close" }).first();
  if (await closeOnboarding.isVisible().catch(() => false)) {
    await closeOnboarding.click({ force: true });
  }

  const skipAll = page.getByRole("button", { name: "Skip all" });
  if (await skipAll.isVisible().catch(() => false)) {
    await skipAll.click({ force: true });
  }

  const row = page.locator(".emulator-list-item", { hasText: deviceSerial });
  await expect(row).toBeVisible({ timeout: 15_000 });

  await page.evaluate((serial) => {
    const rows = Array.from(document.querySelectorAll(".emulator-list-item"));
    const rowEl = rows.find((r) => r.textContent?.includes(serial));
    if (!rowEl) {
      throw new Error(`device row not found for ${serial}`);
    }

    const btns = Array.from(rowEl.querySelectorAll("button"));
    const connectBtn = btns.find((b) => b.textContent?.trim() === "Connect");
    if (!connectBtn) {
      throw new Error(`connect button not found for ${serial}`);
    }
    (connectBtn as HTMLButtonElement).click();
  }, deviceSerial);

  await expect(page.locator(".emulator-connection-state")).toHaveText(
    /connected$/,
    { timeout: 30_000 },
  );

  const video = page.locator("video.emulator-video");
  await expect(video).toBeVisible();

  await expect(async () => {
    const readyState = await page.evaluate(
      () =>
        (
          document.querySelector(
            "video.emulator-video",
          ) as HTMLVideoElement | null
        )?.readyState ?? 0,
    );
    expect(readyState).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 5_000 });
});
