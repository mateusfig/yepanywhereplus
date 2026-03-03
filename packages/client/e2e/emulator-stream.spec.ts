/**
 * E2E test for Android emulator WebRTC streaming.
 *
 * Requires:
 *   - A running Android emulator (detected via `adb devices`)
 *   - The device-bridge binary built at packages/device-bridge/bridge
 *
 * Skipped automatically when either prerequisite is missing, so this is
 * safe to run in CI (where no emulator is available).
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BRIDGE_BINARY = resolve(__dirname, "../../device-bridge/bridge");
const DEFAULT_APK_PATH = resolve(
  __dirname,
  "../../android-device-server/app/build/outputs/apk/release/yep-device-server.apk",
);

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
      execSync(`${candidate} version`, { timeout: 3000, stdio: "ignore" });
      return candidate;
    } catch {
      // not found or not executable
    }
  }
  return null;
}

function findRunningEmulator(): string | null {
  const adb = findAdb();
  if (!adb) return null;
  try {
    const output = execSync(`${adb} devices`, { timeout: 5000 }).toString();
    const match = output.match(/^(emulator-\d+)\s+device$/m);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function apkOverrideEnabled(): boolean {
  return isTruthy(process.env.DEVICE_BRIDGE_USE_APK_FOR_EMULATOR);
}

async function assertAutoStreamConnects(
  page: import("@playwright/test").Page,
  baseURL: string,
) {
  test.skip(
    !existsSync(BRIDGE_BINARY),
    "device-bridge binary not built — run: cd packages/device-bridge && go build -o bridge ./cmd/bridge/",
  );

  const runningEmulator = findRunningEmulator();
  test.skip(
    !runningEmulator,
    "No running Android emulator — run: emulator -avd <name> -no-window &",
  );

  await page.goto(`${baseURL}/emulator?auto`);

  // Wait for WebRTC to reach "connected" — generous timeout covers sidecar
  // cold start, ADB query, ICE gathering, and first frame.
  await expect(page.locator(".emulator-connection-state")).toHaveText(
    /connected$/,
    { timeout: 30_000 },
  );

  // Video element must be visible
  const video = page.locator("video.emulator-video");
  await expect(video).toBeVisible();

  // Video must have received at least one frame (readyState >= HAVE_CURRENT_DATA)
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
}

test("streams emulator video over WebRTC when ?auto is set", async ({
  page,
  baseURL,
}) => {
  await assertAutoStreamConnects(page, baseURL);
});

test("streams emulator video over WebRTC via APK transport override", async ({
  page,
  baseURL,
}) => {
  test.slow();
  test.skip(
    !apkOverrideEnabled(),
    "Set DEVICE_BRIDGE_USE_APK_FOR_EMULATOR=true to run APK transport override variant",
  );

  const apkPath = process.env.ANDROID_DEVICE_SERVER_APK ?? DEFAULT_APK_PATH;
  test.skip(
    !existsSync(apkPath),
    `APK not found at ${apkPath}; build it with: cd packages/android-device-server && ./build-apk.sh`,
  );

  await assertAutoStreamConnects(page, baseURL);
});
