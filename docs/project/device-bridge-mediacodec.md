# Android Real-Device Streaming: MediaCodec Hardware Encoding

## Problem

The current real-device capture pipeline polls screenshot APIs per frame. Each call to `ScreenCapture.capture()` or `SurfaceControl.captureDisplay()` costs ~400ms on a Pixel 7a (Android 16), capping throughput at ~2.5 fps before any streaming overhead. The bottleneck is on-device capture, not WebRTC or x264.

Current pipeline (per frame):
```
Screenshot API call (~400ms)
  → Hardware bitmap → software copy
  → Optional downscale
  → JPEG encode (Bitmap.compress)
  → TCP send to Go sidecar
  → JPEG decode → RGB → I420 → x264 encode
  → WebRTC RTP
```

## Solution: Continuous VirtualDisplay → Hardware H.264

Replace per-frame screenshot polling with a persistent VirtualDisplay that mirrors the physical screen into a hardware MediaCodec encoder. The encoder outputs H.264 NAL units continuously — no bitmap readback, no CPU image processing, no re-encoding on the Go side.

New pipeline:
```
DisplayManager.createVirtualDisplay() or SurfaceControl.createDisplay() (once)
  → VirtualDisplay mirrors physical screen (continuous)
  → MediaCodec hardware H.264 encoder (continuous)
  → NAL units over TCP to Go sidecar
  → Go forwards NALs directly to WebRTC
```

Expected improvement: ~2.5 fps / 400ms latency → 30-60 fps / <50ms latency.

## Compatibility Contract (Must Keep)

The legacy screenshot path is still the default fallback and must remain valid:

- `0x01`/`0x02` frame request/response remains unchanged
- `0x03` control remains unchanged
- If `stream_start` is unsupported (older APK), sidecar falls back to `GetFrame()` polling
- Emulator and ChromeOS paths remain on existing frame/x264 pipeline

## Display Mirroring: DisplayManager vs SurfaceControl vs MediaProjection

Three APIs can create a VirtualDisplay that mirrors the physical screen. scrcpy uses a two-tier fallback:

| | DisplayManager (preferred) | SurfaceControl (fallback) | MediaProjection |
|---|---|---|---|
| User consent dialog | No | No | Yes (system UI prompt) |
| Shell user access | Yes (hidden API) | Yes (hidden API) | Unreliable from shell |
| API level | Varies by method | Android 5+ | Android 5+ |
| Android 14+ | Methods may move to `DisplayControl` class | Same | Same |
| scrcpy uses it | Primary path | Fallback | Never |

scrcpy's strategy (`ScreenCapture.java:127-144`):
1. Try `DisplayManager.createVirtualDisplay(name, w, h, displayId, surface)` first
2. If that fails, fall back to `SurfaceControl.createDisplay()` + transaction setup
3. Never uses MediaProjection

Since `DeviceServer.java` already runs as shell user via `app_process` and already uses reflection for `SurfaceControl` screenshot APIs, we follow the same two-tier approach.

### Android Version Considerations

From scrcpy's `SurfaceControl.java` and `DisplayControl.java`:

- **Android 5-9:** `SurfaceControl.getBuiltInDisplay(0)` to get physical display token
- **Android 10-13:** `SurfaceControl.getInternalDisplayToken()` (no parameter)
- **Android 14+:** Physical display methods moved to `DisplayControl` class — `DisplayControl.getPhysicalDisplayToken(long)` and `getPhysicalDisplayIds()`
- **Android 12+:** `secure` flag on `createDisplay()` may be restricted

Our existing `DeviceServer.java` already handles some of these version differences for screenshot capture. The streaming path needs the same version-aware reflection.

## APK Changes (DeviceServer.java)

### New Streaming Mode

Add a `MediaCodecStreamer` class alongside the existing `FrameCapturer` backends. The existing screenshot path stays intact for single-frame capture (agent CLI, etc.); streaming uses the new path.

**Activation:** New control command starts/stops the stream:
```json
{"cmd": "stream_start", "width": 720, "height": 1600, "bitrate": 2000000, "fps": 30}
{"cmd": "stream_stop"}
```

When streaming is active, the device pushes NAL units continuously instead of waiting for `0x01` frame requests.

### Key Components

**1. VirtualDisplay setup (two-tier, following scrcpy)**

```java
// Tier 1: DisplayManager (preferred)
try {
    // DisplayManager.createVirtualDisplay(name, width, height, displayId, surface)
    // Mirrors the physical display identified by displayId
    virtualDisplay = displayManager.createVirtualDisplay(
        "yep-stream", width, height, displayId, inputSurface);
} catch (Exception e) {
    // Tier 2: SurfaceControl (fallback)
    Object displayToken = SurfaceControl.createDisplay("yep-stream", false);
    SurfaceControl.openTransaction();
    try {
        SurfaceControl.setDisplaySurface(displayToken, inputSurface);
        SurfaceControl.setDisplayProjection(displayToken, 0, deviceRect, displayRect);
        SurfaceControl.setDisplayLayerStack(displayToken, layerStack);
    } finally {
        SurfaceControl.closeTransaction();
    }
}
```

All calls via reflection — same pattern already used in `DeviceServer.java` for screenshot backends.

**2. MediaCodec configuration**

Following scrcpy's proven parameters (`SurfaceEncoder.java:256-286`):

```java
MediaFormat format = new MediaFormat();
format.setString(MediaFormat.KEY_MIME, MediaFormat.MIMETYPE_VIDEO_AVC);
format.setInteger(MediaFormat.KEY_WIDTH, width);
format.setInteger(MediaFormat.KEY_HEIGHT, height);
format.setInteger(MediaFormat.KEY_COLOR_FORMAT,
    MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
format.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);               // e.g. 2 Mbps
format.setInteger(MediaFormat.KEY_FRAME_RATE, 60);                   // scrcpy uses 60 (actual fps is variable)
format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 10);             // scrcpy: keyframe every 10s
format.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000); // repeat after 100ms idle
// Android 7.0+:
format.setInteger(MediaFormat.KEY_COLOR_RANGE, MediaFormat.COLOR_RANGE_LIMITED);

MediaCodec codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);

// The encoder's input Surface — VirtualDisplay renders into this
Surface inputSurface = codec.createInputSurface();
codec.start();
```

Note: scrcpy sets `KEY_FRAME_RATE = 60` as a hint but actual FPS is determined by display refresh and `KEY_MAX_FPS_TO_ENCODER` (float, available as private API pre-Android 10, public in 10+). We can use `KEY_MAX_FPS_TO_ENCODER` for real FPS capping.

**3. Encoder output loop**

scrcpy uses blocking `dequeueOutputBuffer(bufferInfo, -1)` (infinite wait). We use a bounded timeout so we can check for stop signals:

```java
MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
while (streaming) {
    int index = codec.dequeueOutputBuffer(info, 100_000); // 100ms timeout
    if (index >= 0) {
        ByteBuffer buf = codec.getOutputBuffer(index);
        boolean isConfig = (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0;
        boolean isKeyframe = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
        sendNalUnit(buf, info.size, isConfig, isKeyframe, info.presentationTimeUs);
        codec.releaseOutputBuffer(index, false);
    }
}
```

**4. Size downgrade on initial failure**

scrcpy retries with progressively smaller sizes if the encoder fails before producing the first frame (`SurfaceEncoder.java:149-182`). Fallback sizes: 2560, 1920, 1600, 1280, 1024, 800. Max 3 retries. We should do the same — some hardware encoders reject large resolutions.

### Dynamic Controls (No Pipeline Restart)

MediaCodec supports these mid-stream via `setParameters()`:

```json
{"cmd": "stream_bitrate", "bps": 1000000}
{"cmd": "stream_keyframe"}
```

Implementation:
```java
// Bitrate change — takes effect within 1-2 frames
Bundle params = new Bundle();
params.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, newBitrate);
codec.setParameters(params);

// Keyframe request — next frame is an I-frame
Bundle kf = new Bundle();
kf.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
codec.setParameters(kf);
```

**FPS control:** Unlike bitrate and keyframe, there's no `setParameters()` for FPS. scrcpy doesn't support mid-stream FPS changes either. Options:
- Use `KEY_MAX_FPS_TO_ENCODER` at configure time (requires pipeline restart to change)
- Throttle on the Go side by dropping frames at a target cadence (wasteful but no restart)
- Accept that FPS is primarily controlled by bitrate (lower bitrate → encoder naturally produces fewer high-quality frames)

For backpressure, bitrate reduction + keyframe requests are the primary levers. FPS reduction via pipeline restart is a last resort.

### Rotation Handling

scrcpy restarts the entire capture+encode pipeline on rotation change (`DisplaySizeMonitor.java:109-140` detects rotation → `CaptureReset.java` calls `signalEndOfInputStream()` → `SurfaceEncoder.java` do-while loop restarts). We should do the same:

1. Monitor display rotation (polling or listener)
2. On change: `codec.signalEndOfInputStream()` → teardown VirtualDisplay → reconfigure with new dimensions → restart

This causes a brief interruption but rotation changes are infrequent.

### Wire Protocol Extension

New message types for streaming:

```
Stream status (device → sidecar, length-prefixed JSON):
  [0x04][len u32 LE][json bytes]
  e.g. {"cmd":"stream_start","ok":true,"width":720,"height":1600,"bitrate":2000000,"fps":30}
```

```
Stream NAL (device → sidecar, push-based):
  [0x05][flags u8][pts u64 LE][len u32 LE][H.264 NAL bytes]

  flags:
    bit 0: keyframe (1 = IDR frame, 0 = P-frame)
    bit 1: config (1 = SPS/PPS, 0 = frame data)
```

`0x05` distinguishes stream data from `0x02` JPEG frame responses. The existing `0x01`/`0x02` request-response protocol continues to work for single-frame screenshots when not streaming.

`0x04` allows explicit start/failure reporting so the sidecar can quickly decide between MediaCodec and fallback polling.

PTS (presentation timestamp, microseconds) is included for proper frame timing on the WebRTC side. scrcpy uses a similar 12-byte header: 8-byte PTS+flags (flags in top 2 bits), 4-byte size (`Streamer.java:85-109`). Our format is slightly different (separate flags byte) for simpler parsing.

The `flags` byte lets the Go side make drop decisions without parsing H.264:
- Always forward `config` packets (SPS/PPS) — needed to initialize the decoder
- Can safely drop non-keyframe packets during congestion
- After dropping, request a keyframe to resync

## Go Sidecar Changes (device-bridge)

### New Stream Mode in AndroidDevice

`AndroidDevice` gains a `StartStream()`/`StopStream()` method pair. When streaming:

- Sends `stream_start` command to the APK
- Switches from poll-based `GetFrame()` to push-based NAL reader
- Exposes NALs through a new `NalSource` (analogous to `FrameSource`)

```go
type NalUnit struct {
    Data     []byte
    Keyframe bool
    Config   bool   // SPS/PPS
    PTS      int64  // microseconds
}

type NalSource struct {
    // Same subscribe/unsubscribe pattern as FrameSource
}
```

### Pipeline Bypass

When streaming from a real device with MediaCodec, the pipeline in `signaling.go` changes from:

```
FrameSource → ScaleAndConvertToI420 → H264Encoder.Encode → WriteVideoSample
```

to:

```
NalSource → WriteVideoSample (direct passthrough)
```

The `FrameSource` / `H264Encoder` path remains for emulators (gRPC screenshots → x264).

The `SignalingHandler` / `runPipeline` need to support both modes. Options:
- **Interface approach:** Define a `VideoSource` interface with `Subscribe()`/`Unsubscribe()` that both `FrameSource`+encoder and `NalSource` implement
- **Flag approach:** `runPipeline` checks the device type and runs the appropriate loop

The interface approach is cleaner since the signaling handler shouldn't know about device types.

### Backpressure & Adaptive Quality

**How scrcpy handles it:** Blocking. `dequeueOutputBuffer(-1)` blocks until the consumer reads. No frame dropping, no adaptive quality. If the socket is slow, the encoder just stalls. On broken pipe, it exits.

**We need more because** our path goes through WebRTC over potentially-slow mobile networks, not a local USB socket. The Go side should actively manage quality.

**Congestion detection signals:**
1. **WebRTC RTCP feedback** — Pion fires PLI (Picture Loss Indication) when the browser detects missing frames. Already handled via `ReadRTCP()` in `peer.go`.
2. **NAL queue depth** — if the subscriber channel backs up, frames are arriving faster than they can be sent.
3. **Write errors** — `WriteVideoSample` failures indicate transport congestion.

**Response strategy (progressive):**

```
1. Mild congestion (queue > 2 NALs):
   → Reduce bitrate by 25%
   → Send {"cmd": "stream_bitrate", "bps": <reduced>}

2. Moderate congestion (queue > 5 NALs or PLI received):
   → Request keyframe + drop queued non-keyframe NALs
   → Send {"cmd": "stream_keyframe"}

3. Severe congestion (sustained for >2s):
   → Drop to minimum bitrate (500kbps)
   → Request keyframe, flush queue

4. Recovery (queue empty for >1s):
   → Ramp bitrate back up by 25% per second
```

Note: FPS reduction requires pipeline restart (no mid-stream `setParameters` for FPS), so we prefer bitrate reduction as the primary lever. FPS change is a last resort requiring `stream_stop` + `stream_start`.

**NAL dropping rules:**
- Never drop SPS/PPS config packets
- Never drop keyframes (IDR)
- Can drop P-frames, but must request a keyframe afterward
- After any drop, the next forwarded frame must be a keyframe

### Resolution Changes

Resolution requires recreating the VirtualDisplay and MediaCodec (can't resize mid-stream — scrcpy also restarts the full pipeline for this). The Go side sends:

```json
{"cmd": "stream_stop"}
{"cmd": "stream_start", "width": 540, "height": 1200, "bitrate": 1000000, "fps": 30}
```

This causes a brief interruption (~100ms). Use sparingly — prefer bitrate adjustment first.

## Compatibility & Fallback

The MediaCodec path requires:
- `DisplayManager.createVirtualDisplay()` or `SurfaceControl.createDisplay()` — Android 5+ from shell user
- `MediaCodec` with `COLOR_FormatSurface` — Android 5+

Scrcpy handles initial encoder failure by retrying with smaller sizes (2560 → 1920 → 1600 → 1280 → 1024 → 800), up to 3 retries. We do the same. If the encoder still fails, fall back to the existing screenshot-polling path. The APK responds to `stream_start` with an error JSON, so the Go side knows to use `GetFrame()` polling instead.

## Implementation Phases

Each phase/slice must be gated by tests before landing.

### Phase 1 — MediaCodec streaming in APK

1. Add `MediaCodecStreamer` class to `DeviceServer.java`
   - Two-tier VirtualDisplay setup: DisplayManager (preferred) → SurfaceControl (fallback)
   - Version-aware reflection (Android 5-9, 10-13, 14+ display token APIs)
   - MediaCodec H.264 encoder with `createInputSurface()`
   - Output loop reading NAL units and sending via `0x05` messages
   - Size downgrade retry on initial encoder failure (scrcpy pattern)
2. Add `stream_start` / `stream_stop` / `stream_bitrate` / `stream_keyframe` command handlers
3. Add rotation detection → pipeline restart
4. Test standalone: `adb forward` + read raw NAL output, verify with ffprobe/ffplay

### Phase 2 — Go sidecar NAL passthrough + fallback

1. Add `0x05` message parsing to `conn` package
2. Add `NalSource` with subscribe/unsubscribe (mirrors `FrameSource` API)
3. Add `StartStream()` / `StopStream()` to `AndroidDevice`
4. Modify `runPipeline` to support NAL passthrough mode (skip JPEG decode + x264)
5. Test: real device → WebRTC → browser video at 30fps

### Phase 2A (current slice) status

- Added protocol constants and framing support for `0x04`/`0x05`
- Added Android stream controls and NAL source path in `device-bridge`
- Added automatic fallback: stream startup timeout/error returns to screenshot polling
- Kept legacy API behavior intact (`GetFrame` path unchanged when stream mode is unavailable)

Known gap in this slice:
- APK streaming currently prioritizes `SurfaceControl.createDisplay()` path; broader DisplayManager two-tier fallback remains follow-up hardening.

### Phase 3 — Adaptive quality

1. Add congestion detection (queue depth monitoring, PLI forwarding)
2. Implement progressive backpressure (bitrate → keyframe request → resolution)
3. Add recovery ramp-up logic
4. Wire PLI from Pion RTCP → `stream_keyframe` command to APK

### Phase 4 — Polish

1. Auto-detect device capability: try `stream_start`, fall back to polling if it fails
2. Client UI: show current stream stats (fps, bitrate, resolution)
3. Client controls: manual quality override (low/medium/high presets)
4. Benchmark: measure end-to-end latency and fps on multiple devices

## Test Gates By Slice

Minimum required gates:

1. **Protocol gate** (`packages/device-bridge/internal/conn/framing_test.go`)
   - Legacy framing still passes
   - `TypeStreamStatus (0x04)` round-trip
   - `TypeStreamNAL (0x05)` round-trip

2. **Android transport gate** (`packages/device-bridge/internal/device/android_device_test.go`)
   - Stream unsupported ⇒ timeout ⇒ fallback to `GetFrame` still works
   - Stream supported ⇒ NAL reception works

3. **Bridge pipeline gate** (`packages/device-bridge/internal/ipc/...`)
   - Android stream path can start
   - Fallback path still works when stream unavailable

4. **Browser E2E gate** (`packages/client/e2e/*.spec.ts`)
   - Existing emulator and physical-android Playwright streaming tests must remain green
   - APK transport override E2E remains required for regression testing

## Reference: scrcpy Source

Local clone: `~/code/references/scrcpy/`

Key files in `server/src/main/java/com/genymobile/scrcpy/`:

| File | What to study |
|------|---------------|
| `video/SurfaceEncoder.java` | Encoding loop (197-224), MediaFormat config (256-286), size downgrade retry (149-182) |
| `video/ScreenCapture.java` | Two-tier VirtualDisplay creation (127-144), display projection setup (204-212), rotation handling |
| `wrappers/SurfaceControl.java` | Reflection wrappers for createDisplay, setDisplaySurface/Projection/LayerStack (40-121) |
| `wrappers/DisplayControl.java` | Android 14+ physical display token APIs (49-81) |
| `wrappers/DisplayManager.java` | DisplayManager.createVirtualDisplay reflection (163-182) |
| `device/Streamer.java` | NAL framing: 8-byte PTS+flags + 4-byte size header (85-109) |
| `video/CaptureReset.java` | Pipeline restart via signalEndOfInputStream (14-36) |
| `video/DisplaySizeMonitor.java` | Rotation/size change detection (41-77, 109-140) |
| `video/NewDisplayCapture.java` | Alternative: new virtual display (not mirroring physical) |

## File Locations

| Component | Path |
|-----------|------|
| APK source | `packages/android-device-server/app/src/main/java/com/yepanywhere/DeviceServer.java` |
| Go device abstraction | `packages/device-bridge/internal/device/android_device.go` |
| Go frame source | `packages/device-bridge/internal/device/frame_source.go` |
| Go encoder (emulator path) | `packages/device-bridge/internal/encoder/h264.go` |
| Go WebRTC pipeline | `packages/device-bridge/internal/stream/signaling.go` |
| Wire protocol | `packages/device-bridge/internal/conn/framing.go` |
| scrcpy reference | `~/code/references/scrcpy/` |
| This doc | `docs/project/device-bridge-mediacodec.md` |
