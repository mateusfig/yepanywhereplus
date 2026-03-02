# Device Bridge: Extending Remote Control Beyond the Emulator

## Goal

The emulator remote control (see [android-emulator-remote-control.md](android-emulator-remote-control.md)) is complete through Phase 3. It streams a running Android emulator to any browser via WebRTC, with touch and key input over a DataChannel. The sidecar binary (`emulator-bridge`) handles encoding and WebRTC; the Yep server manages its lifecycle.

This document covers extending that same architecture to support **physical Android devices over USB** and (as a personal/internal tool) **ChromeOS devices over SSH**. The emulator path remains fully intact — we're widening the system, not replacing it.

## What Exists

The entire pipeline is built and working for emulators:

```
Phone ──(relay)──► Yep Server ──(WS IPC)──► Go sidecar ──(gRPC)──► Android Emulator
                                                  │
                                        WebRTC P2P (H.264 video + DataChannel input)
                                                  │
                                               Phone
```

Key pieces in `packages/emulator-bridge/`:
- **`internal/emulator/`** — gRPC client wrapping Android Emulator's screenshot/input API; `FrameSource` pub/sub with auto-pause when no subscribers
- **`internal/encoder/`** — RGB888→I420 conversion + x264 H.264 encoding (ultrafast/zerolatency)
- **`internal/stream/`** — Pion WebRTC peer, trickle ICE, DataChannel input handler
- **`internal/ipc/`** — session lifecycle, ref-counted resource pool, ADB discovery
- **`packages/server/src/emulator/`** — TypeScript service managing sidecar process + IPC

Everything above the `emulator/` package (encoding, WebRTC, session pool) is device-agnostic already. The emulator gRPC client is the only device-specific part.

## What Changes

### Naming

The package and all external-facing names say "emulator" when they mean any testbed device. This gets renamed throughout before adding new device types.

| Current | New |
|---|---|
| `packages/emulator-bridge/` | `packages/device-bridge/` |
| `EmulatorBridgeService` | `DeviceBridgeService` |
| `emulator_stream_start` / `emulator_webrtc_offer` / … | `device_stream_start` / `device_webrtc_offer` / … |
| `/api/emulators` | `/api/devices` |
| `EmulatorInfo`, `EmulatorStreamStart`, … | `DeviceInfo`, `DeviceStreamStart`, … |
| `capabilities.emulator` | `capabilities.deviceBridge` |
| Go IPC messages `session.start.emulatorId` | `session.start.deviceId` |

Internal Go package names (`internal/emulator/`, `internal/encoder/`, etc.) stay as-is — they're implementation details.

### Device abstraction

Currently the session pipeline talks directly to `*emulator.Client`. Extracting a `Device` interface lets `emulator.Client`, `AndroidDevice`, and `ChromeOSDevice` all plug into the same session/pool machinery:

```go
type Device interface {
    GetFrame(ctx context.Context, maxWidth int) (*Frame, error)
    SendTouch(ctx context.Context, touches []TouchPoint) error
    SendKey(ctx context.Context, key string) error
    ScreenSize() (width, height int32)
    Close() error
}
```

`emulator.Client` already has all these methods. No behavior change — just a formalized interface.

`DeviceInfo` gains a `type` field:

```go
type DeviceInfo struct {
    ID    string            // "emulator-5554", ADB serial, or hostname
    Label string            // "Pixel 7 (emulator)", "Pixel 8 Pro", "Chromebook"
    Type  string            // "emulator" | "android" | "chromeos"
    State string            // "running" | "stopped" | "connected"
}
```

Canonical client schema (shared `packages/shared/src/devices.ts`):

```ts
type DeviceType = "emulator" | "android" | "chromeos" | "ios-simulator";
type DeviceState = "running" | "stopped" | "connected" | "disconnected" | "booted";

interface DeviceInfo {
  id: string;
  label: string;
  type: DeviceType;
  state: DeviceState;
  actions?: ("stream" | "screenshot" | "start" | "stop")[];
  avd?: string; // legacy compatibility
}
```

`device_stream_start` should include `deviceType` whenever the client has it,
so the server does not rely on ID heuristics for runtime selection.

### Frame capture model: pull for all device types

The emulator uses pull (sidecar polls gRPC). Physical Android and ChromeOS also use pull — neither has a public "frame ready" notification without root. The `FrameSource` polling loop works unchanged for all device types. `Device.GetFrame()` is the only addition.

---

## New Device Types

### Physical Android (primary goal)

Android devices connected via USB. No root needed. Uses the same `app_process` technique scrcpy discovered: running as the `shell` user via `adb shell app_process` is enough to call `SurfaceControl.screenshot()` and `InputManager.injectInputEvent()` via reflection.

**On-device: APK server**

A minimal APK (`yep-device-server.apk`) with no UI, no manifest permissions, no install dialog. Launched by the sidecar:

```bash
adb -s <serial> push yep-device-server.apk /data/local/tmp/
adb -s <serial> shell CLASSPATH=/data/local/tmp/yep-device-server.apk \
    app_process /system/bin com.yepanywhere.DeviceServer
adb -s <serial> forward tcp:27183 tcp:27183   # video
adb -s <serial> forward tcp:27184 tcp:27184   # control
```

APK listens on two TCP ports. No connection to the internet, no permissions.

**Wire protocol (single connection)**

One `adb forward`, one port (27183). A small message framing protocol handles both video and control on the same connection:

```
Handshake (device → sidecar on connect):
  [width uint16 LE][height uint16 LE]

Frame request (sidecar → device):
  [0x01]

Frame response (device → sidecar):
  [0x02][4-byte LE JPEG length][JPEG bytes]

Control command (sidecar → device, fire-and-forget, no response):
  [0x03][4-byte LE JSON length][JSON bytes]
  e.g. {"cmd":"touch","touches":[{"x":0.5,"y":0.3,"pressure":1.0}]}
       {"cmd":"key","key":"back"}
```

Touch and key commands are fire-and-forget — no ack needed. The device runs a reader goroutine (handles 0x01 frame requests and 0x03 commands) and a writer goroutine (sends 0x02 frames). The sidecar's video and input goroutines share the single connection with a write mutex.

JPEG because `Bitmap.compress(JPEG, 70, stream)` is built-in on Android and the sidecar decodes to YUV for x264 anyway — much smaller than raw RGB888 over the ADB tunnel.

**Go sidecar: `AndroidDevice`**

Implements `Device`. Connects to `localhost:27183/27184` (after sidecar does `adb forward`), reads handshake for screen dimensions, dispatches `GetFrame()` / `SendTouch()` / `SendKey()` over the two connections.

**Discovery**

`adb devices` already lists physical devices and emulators. Discovery reports both. Physical devices get `type: "android"`, emulators keep `type: "emulator"`. The sidecar handles APK push + `adb forward` automatically when a physical device is selected.

**APK distribution**

CI builds and attaches `yep-device-server.apk` to GitHub releases alongside the sidecar binary. Yep server auto-downloads it to `~/.yep-anywhere/bin/yep-device-server.apk` on first use, same mechanism as the sidecar binary.

---

### ChromeOS (personal/internal)

For Chromebooks with developer mode and SSH root access (`chromeroot` in `~/.ssh/config`). Not batteries-included — the user is expected to have SSH tunnels set up manually. No auto-discovery, no auto-deploy from the UI.

**On-device: `daemon.py`** *(lives in `chromeos-testbed`, private repo)*

A thin stdin/stdout binary-framing wrapper around the existing `client.py` logic. No TCP port — not even localhost-only. All the input and screenshot primitives already exist (`drm_screenshot` via EGL/GBM, `VirtualMouse`, evdev touch/keyboard). The daemon adds:
- Binary framing over stdin/stdout (same protocol as Android)
- Frame loop calling `drm_screenshot_jpeg()` at target FPS responding to 0x01 requests
- 0x03 control commands dispatched to existing `client.py` handlers

Deploy manually:
```bash
scp ~/code/chromeos-testbed/daemon.py chromeroot:/mnt/stateful_partition/c2/
```

**Go sidecar: `ChromeOSDevice`** *(lives in this repo, `packages/device-bridge/internal/device/`)*

Runs `ssh chromeroot python3 /mnt/stateful_partition/c2/daemon.py` as a subprocess. The SSH process's stdin/stdout *is* the connection — same framing protocol as Android, just over pipes instead of a TCP socket. Nothing listens on the Chromebook; the SSH session is the transport. The sidecar manages the SSH process lifetime directly.

```go
cmd := exec.Command("ssh", "chromeroot",
    "python3 /mnt/stateful_partition/c2/daemon.py")
// talk the same frame/control protocol over cmd.Stdin + cmd.Stdout
```

The `tap`/`mouse_move`/`key` control commands map directly to the existing `client.py` handlers. `chromeroot` is read from a `CHROMEOS_HOST` env var (default `chromeroot`).

---

## Implementation Phases

### Phase 0 — Baseline tests (write before touching any code)

The E2E test establishes a green baseline for the full streaming stack. Two unit-level tests fill in the gaps below it.

**Already done:**
- ✅ E2E: `packages/client/e2e/emulator-stream.spec.ts` — full stack regression (sidecar → WebRTC → browser video)

**Still needed:**

1. **Go: binary framing protocol round-trip** (`packages/emulator-bridge/internal/conn/framing_test.go`)

   The framing layer — `[0x01]` frame request, `[0x02][4-byte len][JPEG]` frame response, `[0x03][4-byte len][JSON]` control — is the shared wire protocol that all device types will implement. A bug here silently breaks everything. Test it in isolation with `io.Pipe()` before any device type exists:

   ```go
   func TestFramingRoundTrip(t *testing.T) {
       server, client := io.Pipe() // fake device ↔ sidecar connection

       // fake device side: respond to frame request with test JPEG
       go func() {
           // read 0x01 frame request
           // write 0x02 + length + bytes
       }()

       // sidecar side: send request, read response
       // assert bytes match
   }
   ```

   Write it in `emulator-bridge` now; it moves to `device-bridge` with the rename in Phase 1.

2. **TypeScript: WebSocket message router dispatch** (`packages/server/src/routes/ws-message-router.test.ts`)

   The router at `ws-message-router.ts` dispatches `emulator_stream_start`, `emulator_webrtc_answer`, `emulator_ice_candidate`, `emulator_stream_stop` to `EmulatorBridgeService`. This is currently untested and is exactly what the Phase 1 rename will touch. A simple unit test with a mock service object verifies the routing table is wired correctly:

   ```typescript
   it("routes emulator_stream_start to bridgeService.startStream()", async () => {
     const mockBridgeService = { startStream: vi.fn() }
     // dispatch message → assert mockBridgeService.startStream was called
   })
   ```

**Phase 0 completion check:** `pnpm test` (unit tests) + E2E test both pass.

---

### Phase 1 — Rename (mechanical, no behavior change)

1. Rename `packages/emulator-bridge/` → `packages/device-bridge/` (directory + build files)
2. Rename `EmulatorBridgeService` → `DeviceBridgeService` and all TypeScript types in `packages/shared/src/emulator.ts` → `devices.ts`
3. Rename WebSocket message types (`emulator_stream_*` → `device_stream_*`)
4. Rename REST routes `/api/emulators` → `/api/devices`
5. Update all imports, references, and the client UI

The emulator tab in the UI can still be labeled "Emulators" or "Devices" — that's a separate UX decision.

**Output:** identical behavior, clean naming.

**Phase 1 completion check:** `pnpm typecheck && pnpm lint && pnpm test` all pass. Then run the E2E test — this is the primary safety net for the rename.

---

### Phase 2 — Device interface + ChromeOS daemon

ChromeOS first: `client.py` already has all the primitives, the SSH subprocess approach needs no deployment ceremony, and the Chromebook is always on.

1. Add `Device` interface in `packages/device-bridge/internal/device/device.go`; make `emulator.Client` implement it (minimal wiring change in `FrameSource` + `SessionManager`)
2. Write `daemon.py` in **`chromeos-testbed` repo** (private) — stdin/stdout binary framing, `drm_screenshot_jpeg` for frames, existing `client.py` handlers for control
3. Write `ChromeOSDevice.go` in `packages/device-bridge/internal/device/` — launches `ssh $CHROMEOS_HOST python3 daemon.py`, speaks the shared framing protocol over SSH stdin/stdout
4. Wire `ChromeOSDevice` into `SessionManager` and pool; add `type: "chromeos"` to `DeviceInfo`
5. Manual config only: `CHROMEOS_HOST` env var (default `chromeroot`); no auto-discovery

**New tests for Phase 2:**

- **Go: `ChromeOSDevice` framing with mock subprocess** — use `io.Pipe()` to fake the SSH stdin/stdout. Send a handshake, a frame request, and a control command; verify the device side handles each correctly. No real SSH, no real Chromebook.
- **Go: `FrameSource` works with `Device` interface** — a minimal test that `FrameSource` calls `GetFrame()` on a mock `Device` and distributes the result to subscribers, confirming the interface wiring didn't break the existing emulator path.

**Phase 2 completion check:** `go test ./...` in `packages/device-bridge` passes. Then run the E2E test to confirm emulator path still works after the `Device` interface refactor.

---

### Phase 3 — Android physical device

All code lives in this repo.

1. Add `packages/android-device-server/` — Android APK source (`app_process` entrypoint, `SurfaceControl` screenshot loop, `InputManager` injection, single TCP listener on 27183)
2. Write `AndroidDevice.go` in `packages/device-bridge/internal/device/` — TCP client for the ADB-forwarded connection, same framing protocol
3. Wire `AndroidDevice` into `SessionManager` and pool; extend `adb devices` discovery to emit both physical and emulator types
4. Sidecar handles APK push + `adb forward` automatically when a physical device is selected
5. Add APK build + release artifact to CI alongside sidecar binary

**Phase 3 progress (2026-03-02):**
- ✅ `bridge-ci.yml` now builds/releases `device-bridge-*` binaries and `yep-device-server.apk`
- ✅ Server download endpoint now pulls both artifacts (`POST /api/devices/bridge/download`)
- ✅ `DeviceBridgeService.startStream()` auto-ensures APK availability for Android/APK transport sessions

**New tests for Phase 3:**

- **Go: `AndroidDevice` with mock TCP server** — spin up a `net.Listen` TCP server in the test, run `AndroidDevice` against it. Send handshake + a frame response; assert `GetFrame()` returns the correct bytes.
- **Go: ADB device-list parsing** — unit test that `adb devices` output with a mix of emulator serials and physical serials (e.g. `R3CN90ABCDE`) is correctly classified as `type: "emulator"` vs `type: "android"`.
- **E2E: physical device variant** (skips if no physical device attached) — same structure as `emulator-stream.spec.ts` but checks `adb devices` for a non-emulator serial instead.

**Phase 3 completion check:** `go test ./...` passes. E2E emulator test still passes (regression). E2E physical device test passes if a device is attached.

---

### Phase 4 — iOS simulator

See **[device-bridge-ios.md](device-bridge-ios.md)** for the full design.

A small Swift CLI (`ios-sim-server`) that accesses the simulator's framebuffer via IOSurface (private `SimulatorKit` framework) and injects touch/key input via IndigoHID. Speaks the same binary framing protocol over stdin/stdout — identical pattern to ChromeOS `daemon.py`. The Go sidecar launches it as a subprocess, same as `ChromeOSDevice`.

1. Add `packages/ios-sim-server/` — Swift Package Manager CLI using private CoreSimulator/SimulatorKit frameworks for IOSurface frame capture + IndigoHID input injection
2. Write `IOSSimulatorDevice.go` in `packages/device-bridge/internal/device/` — subprocess management + stdin/stdout framing, mirrors `ChromeOSDevice`
3. Add iOS simulator discovery via `xcrun simctl list devices booted -j`; report as `type: "ios-simulator"` in `DeviceInfo`
4. Binary built from source on first use (`swift build -c release`) since private frameworks are Xcode-version-specific

**New tests for Phase 4:**

- **Go: `IOSSimulatorDevice` with mock subprocess** — `io.Pipe()` fake stdin/stdout, same pattern as ChromeOS device tests
- **Go: simctl device-list JSON parsing** — unit test for booted simulator discovery
- **E2E: iOS simulator streaming** (skips if no booted simulator) — same structure as `emulator-stream.spec.ts`

**Phase 4 completion check:** `go test ./...` passes. All prior E2E tests still pass (regression). iOS simulator E2E passes if a simulator is booted.

---

---

## Regression Test: Emulator Streaming E2E

**Run this after every phase and after any significant change to the sidecar, server emulator routes, WebSocket message handling, or client streaming code.** It is the single test that exercises the entire stack end-to-end.

### What it tests

`packages/client/e2e/emulator-stream.spec.ts` drives a real Playwright browser through the full streaming flow:

1. Navigates to `/emulator?auto`
2. Waits for the WebRTC connection state to reach `"connected"` (30 s timeout)
3. Verifies the `<video>` element is visible
4. Verifies the video has received at least one frame (`readyState >= HAVE_CURRENT_DATA`)

If any link in the chain is broken — sidecar startup, IPC message routing, SDP/ICE signaling, H.264 encoding, or client-side connection state tracking — this test fails.

### Prerequisites

Both must be true or the test **skips automatically** (safe in CI):

1. **Bridge binary is built:**
   ```bash
   cd packages/emulator-bridge
   go build -o bridge ./cmd/bridge/
   ```

2. **A running Android emulator** is attached (checked via `adb devices`):
   ```bash
   source ~/.profile && adb devices   # should show "emulator-5554  device"
   # if not running:
   emulator -avd <avd-name> -no-window &
   ```
   Available AVD names: `emulator -list-avds`

### Running the test

```bash
pnpm test:e2e --grep "streams emulator"
```

Expected output when everything is working:
```
✓  e2e/emulator-stream.spec.ts › streams emulator video over WebRTC when ?auto is set (2.0s)
1 passed
```

Expected output when prerequisites are missing (e.g. in CI):
```
-  e2e/emulator-stream.spec.ts › streams emulator video over WebRTC when ?auto is set
1 skipped
```

### Known environment requirement

The test server must run over plain HTTP. If `HTTPS_SELF_SIGNED=true` is set in your shell, `global-setup.ts` explicitly clears it for the test server — you do not need to unset it manually.

---

## Android Agent Control (Accessibility Tree + CLI)

See **[device-bridge-android-a11y.md](device-bridge-android-a11y.md)** for the full design.

Extends `DeviceServer.java` with `UiAutomation` accessibility tree support so AI agents can understand and interact with Android screens without screenshots. A standalone CLI (`bin/android-agent`) talks directly to the APK over ADB forwarding — independent of the streaming bridge. Modeled after the [chromeos-testbed](~/code/chromeos-testbed) pattern: `snapshot` → `find` → `tap`/`type` → `snapshot` workflow, with compact LLM-friendly output and a skill definition for agent integration.

---

## Non-Goals

- ChromeOS auto-discovery or auto-deploy (manual setup only for now)
- WiFi Android without USB (v2 concern — ADB wireless pairing adds complexity)
- Audio streaming
- General remote desktop (this is a dev/supervision tool)
- Mouse scroll for Android (hover/scroll events ignored by most Android apps)
