# Device Bridge: iOS Simulator Support

## Goal

Add iOS simulator streaming to the device bridge, following the same architecture as ChromeOS and Android physical devices: a small native daemon that speaks the shared binary framing protocol over stdin/stdout, launched as a subprocess by the Go sidecar.

## Background

The iOS simulator exposes its framebuffer as a shared-memory **IOSurface** via Apple's private `SimulatorKit` framework. This is the same mechanism used by Facebook's IDB (`idb_companion`) and the Simulator.app GUI itself. Direct IOSurface access is orders of magnitude faster than `xcrun simctl io screenshot` (~500ms per frame, limited to ~2 FPS).

For input injection, the simulator accepts **IndigoHID** messages — a Mach message-based protocol used internally by SimulatorKit. IDB reverse-engineered the structs and provides MIT-licensed headers we can reference.

## Architecture

Same subprocess-with-framing pattern as ChromeOS and Android:

```
Go sidecar ──(stdin/stdout framing)──► ios-sim-server ──(IOSurface + IndigoHID)──► Simulator
```

Compare with existing device types:

| Device Type | Daemon | Transport | Frame Source | Input Method |
|---|---|---|---|---|
| Android emulator | — (gRPC built-in) | gRPC | Emulator gRPC API | Emulator gRPC API |
| Android physical | `yep-device-server.apk` | TCP via `adb forward` | `SurfaceControl.screenshot()` | `InputManager.injectInputEvent()` |
| ChromeOS | `daemon.py` | SSH stdin/stdout | `drm_screenshot_jpeg()` | evdev (`VirtualMouse`, keyboard) |
| **iOS simulator** | **`ios-sim-server`** | **stdin/stdout** | **IOSurface → VideoToolbox JPEG** | **IndigoHID via SimDeviceLegacyClient** |

## iOS Simulator Daemon (`ios-sim-server`)

A Swift command-line tool (~300 lines) built with Swift Package Manager. Takes a simulator UDID as its sole argument.

### Frame capture

1. Look up the booted `SimDevice` by UDID via CoreSimulator's `SimDeviceSet.defaultSet`
2. Get the main display's IOSurface via `SimDisplayIOSurfaceRenderable.framebufferSurface` (or `.ioSurface` on older Xcode)
3. Wrap IOSurface in a `CVPixelBuffer` via `CVPixelBufferCreateWithIOSurface()`
4. On each 0x01 frame request:
   - Optionally scale with `vImageScale_ARGB8888` (Accelerate framework) for bandwidth reduction
   - Encode to JPEG via `VideoToolbox` (`VTCompressionSession` with `kCMVideoCodecType_JPEG`) using hardware acceleration
   - Write 0x02 response with JPEG payload to stdout

Two frame modes (matching IDB's approach):

- **Eager (default):** On 0x01 request, re-read the current IOSurface pixel buffer and encode. The IOSurface is always current — it's shared memory. Simple polling, no callback registration needed.
- **Lazy (future optimization):** Register a `damageRectanglesCallback` on the display descriptor. Only encode when the screen actually changes. Reduces CPU for static screens.

Start with eager mode — it's simpler and matches the Android/ChromeOS pull model.

### Input injection

Uses the IndigoHID mechanism from SimulatorKit:

1. Load `SimulatorKit.framework` and resolve three C functions via `dlsym`:
   - `IndigoHIDMessageForMouseNSEvent` — touch events
   - `IndigoHIDMessageForKeyboardArbitrary` — key events
   - `IndigoHIDMessageForButton` — hardware buttons (home, lock, siri)

2. Create a `SimDeviceLegacyHIDClient` (from SimulatorKit) initialized with the `SimDevice`

3. On each 0x03 control command:
   - Parse JSON payload (`{"cmd":"touch",...}` or `{"cmd":"key",...}`)
   - Build the appropriate `IndigoMessage` struct
   - Send via `client.sendWithMessage(_:freeWhenDone:)`

Touch coordinates arrive as normalized 0–1 values (matching Android/ChromeOS). Convert to IndigoHID's ratio format:
```
xRatio = touch.x  (already 0–1, from top-left)
yRatio = touch.y
```

### Handshake

Same 4-byte handshake as Android/ChromeOS:
```
[width uint16 LE][height uint16 LE]
```

Screen dimensions from `SimDisplayDescriptorState.defaultWidthForDisplay` / `defaultHeightForDisplay`, or read directly from the IOSurface dimensions.

### Wire protocol

Identical to Android and ChromeOS — the shared binary framing protocol:

```
Handshake (daemon → sidecar on connect):
  [width uint16 LE][height uint16 LE]

Frame request (sidecar → daemon):
  [0x01]

Frame response (daemon → sidecar):
  [0x02][4-byte LE JPEG length][JPEG bytes]

Control command (sidecar → daemon, fire-and-forget):
  [0x03][4-byte LE JSON length][JSON bytes]
```

### Private framework headers

Referenced from IDB's `PrivateHeaders/` directory (MIT-licensed). We need a minimal subset:

| Header | Purpose |
|---|---|
| `Indigo.h` | IndigoMessage, IndigoTouch, IndigoButton structs |
| `Mach.h` | MachMessageHeader for IndigoMessage |
| `SimDisplayIOSurfaceRenderable-Protocol.h` | `.framebufferSurface` / `.ioSurface` access |
| `SimDisplayRenderable-Protocol.h` | `.displaySize`, damage rect callbacks |
| `SimDisplayDescriptorState-Protocol.h` | `.defaultWidthForDisplay`, `.displayClass` |
| `SimDeviceIOPortInterface-Protocol.h` | Port enumeration to find main display |
| `SimDeviceIOProtocol-Protocol.h` | `.ioPorts` on device IO |
| `SimDeviceLegacyClient.h` | `sendWithMessage:freeWhenDone:` for HID input |
| `SimDevice.h` | Device object (`.io`, `.deviceType`, `.UDID`) |
| `SimDeviceSet.h` | `defaultSet.devices` for lookup by UDID |

These are Objective-C headers used via a bridging header in the Swift project.

### Framework dependencies

Linked at build time (all ship with Xcode):

| Framework | Purpose |
|---|---|
| `CoreSimulator` | `SimDevice`, `SimDeviceSet` (private, from Xcode) |
| `SimulatorKit` | `SimDeviceLegacyHIDClient`, IndigoHID functions (private, from Xcode) |
| `IOSurface` | IOSurface object wrapping |
| `CoreVideo` | `CVPixelBufferCreateWithIOSurface` |
| `VideoToolbox` | Hardware JPEG encoding |
| `Accelerate` | `vImageScale_ARGB8888` for downscaling |
| `CoreGraphics` | `CGPoint`, `CGSize` |

### Build

Swift Package Manager, single executable target:

```
packages/ios-sim-server/
├── Package.swift
├── Sources/
│   ├── main.swift              # Entry point, stdin/stdout framing loop
│   ├── Framebuffer.swift       # IOSurface access + JPEG encoding
│   ├── HIDInput.swift          # IndigoHID touch/key/button injection
│   └── BridgeHeaders/          # Obj-C bridging header + private headers
│       ├── bridge.h
│       ├── Indigo.h
│       ├── Mach.h
│       └── ... (subset from IDB PrivateHeaders)
└── Tests/
    └── ... (framing protocol round-trip)
```

Build command:
```bash
cd packages/ios-sim-server
swift build -c release \
  -Xlinker -F/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks \
  -Xlinker -F/Library/Developer/PrivateFrameworks
```

Output: `.build/release/ios-sim-server`

### Distribution

**Cannot cross-compile** — private frameworks are macOS-only and Xcode-version-specific. Two options:

1. **Build on first use** (preferred): Go sidecar runs `swift build -c release` in `packages/ios-sim-server/` when an iOS simulator device is first selected. Cache the binary alongside the device-bridge binary. Similar to how the Android APK is resolved.

2. **CI pre-build for macOS**: GitHub Actions macOS runner builds the binary and attaches it to releases. Downloaded on-demand like the device-bridge binary. Works only if the user's Xcode version matches the CI build.

Option 1 is more robust since private framework layouts can change between Xcode versions. The build is fast (~5 seconds for a small Swift CLI).

---

## Go Sidecar: `IOSSimulatorDevice`

Lives in `packages/device-bridge/internal/device/ios_simulator_device.go`. Mirrors `ChromeOSDevice` almost exactly:

```go
type IOSSimulatorDevice struct {
    udid    string
    cmd     *exec.Cmd
    reader  io.ReadCloser
    writer  io.WriteCloser
    width   int32
    height  int32
    writeMu sync.Mutex
    // ...
}

func NewIOSSimulatorDevice(ctx context.Context, udid string) (*IOSSimulatorDevice, error) {
    serverPath := resolveIOSSimServer()  // find or build the binary
    cmd := exec.CommandContext(ctx, serverPath, udid)
    cmd.Stdin, _ = cmd.StdinPipe()   // we write to daemon's stdin
    cmd.Stdout, _ = cmd.StdoutPipe() // we read from daemon's stdout
    cmd.Start()
    // read 4-byte handshake for screen dimensions
    // return device ready for GetFrame/SendTouch/SendKey
}
```

### Discovery

The Go sidecar discovers iOS simulators via:
```bash
xcrun simctl list devices booted -j
```

This returns JSON with all booted simulators. Each gets reported as `type: "ios-simulator"` in the `DeviceInfo` list.

```go
type DeviceInfo struct {
    ID    string  // UDID from simctl
    Label string  // "iPhone 17 Pro (iOS 26.2)"
    Type  string  // "ios-simulator"
    State string  // "booted"
}
```

Client signaling should pass `deviceType: "ios-simulator"` in
`device_stream_start` so server runtime selection never depends on parsing a
UDID-like `deviceId`.

### Binary resolution

Priority order (same pattern as Android APK):
1. `IOS_SIM_SERVER` env var (explicit path)
2. `{data-dir}/bin/ios-sim-server` (pre-downloaded)
3. Build from source: `swift build -c release` in `packages/ios-sim-server/`

---

## Implementation Steps

### Step 1 — Swift daemon skeleton

1. Create `packages/ios-sim-server/` with Package.swift
2. Copy minimal private headers from IDB `PrivateHeaders/` (Indigo.h, Mach.h, SimDisplay protocols, SimDevice, SimDeviceLegacyClient)
3. Implement `main.swift`:
   - Parse UDID from argv
   - Look up SimDevice by UDID
   - Get IOSurface from main display
   - Write handshake (width/height)
   - Enter read loop: dispatch 0x01 → JPEG frame, 0x03 → HID input
4. Verify: `swift build -c release && echo "test" | .build/release/ios-sim-server <UDID>`

### Step 2 — Frame capture

1. Implement `Framebuffer.swift`:
   - `CVPixelBufferCreateWithIOSurface` to wrap the IOSurface
   - VideoToolbox JPEG compression session (hardware-accelerated)
   - Optional downscaling via `vImageScale_ARGB8888`
2. Verify: manual test capturing frames, compare quality/speed to `simctl screenshot`

### Step 3 — Input injection

1. Implement `HIDInput.swift`:
   - Load SimulatorKit, resolve IndigoHID functions via `dlsym`
   - Create `SimDeviceLegacyHIDClient`
   - Touch: build IndigoMessage from normalized coordinates
   - Key: build IndigoMessage from keycode
   - Button: home, lock, siri
2. Verify: send touch events, confirm simulator responds

### Step 4 — Go sidecar integration

1. Add `ios_simulator_device.go` — subprocess management + framing protocol
2. Add iOS simulator discovery to device list (parse `xcrun simctl list devices booted -j`)
3. Add `type: "ios-simulator"` to `DeviceInfo`
4. Wire into `SessionManager` and pool

### Step 5 — Tests

- **Go: `IOSSimulatorDevice` with mock subprocess** — `io.Pipe()` fake, same pattern as ChromeOS tests
- **Go: simctl JSON parsing** — unit test for device list parsing
- **E2E: iOS simulator streaming** (skips if no booted simulator) — same structure as emulator E2E test

---

## Performance Expectations

| Metric | `simctl screenshot` | `ios-sim-server` (IOSurface) |
|---|---|---|
| Frame latency | ~500ms | <10ms |
| Max FPS | ~2 | 30+ |
| Encoding | N/A (file I/O) | VideoToolbox hardware JPEG |
| Scaling | Not supported | `vImageScale_ARGB8888` before encode |
| Process overhead | New process per frame | Persistent process, shared memory |

---

## Xcode Version Compatibility

The private frameworks change between Xcode versions. Known variations:

- **IOSurface access**: Xcode 13.2+ split `ioSurface` into `framebufferSurface` + `maskedFramebufferSurface`. The daemon tries `framebufferSurface` first, falls back to `ioSurface`.
- **HID client class**: `SimDeviceLegacyHIDClient` has been stable since Xcode 9+.
- **IndigoHID functions**: Stable since Xcode 9+, loaded dynamically via `dlsym` so missing symbols fail gracefully.

Building from source on the user's machine (Step 1 distribution option) sidesteps most compatibility issues since it links against the locally-installed frameworks.

---

## Non-Goals

- Physical iOS device support (requires `usbmuxd` + developer disk images — completely different stack)
- Audio streaming from simulator
- Multiple simultaneous simulator displays (only main display class 0)
- Xcode-less operation (private frameworks require Xcode installed)
