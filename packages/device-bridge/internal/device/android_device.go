package device

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/anthropics/yepanywhere/device-bridge/internal/conn"
)

const (
	defaultAndroidBridgePort      = 27183
	defaultADBPath                = "adb"
	defaultAndroidServerRemoteAPK = "/data/local/tmp/yep-device-server.apk"
	defaultAndroidServerMainClass = "com.yepanywhere.DeviceServer"
	androidServerAPKEnvVar        = "ANDROID_DEVICE_SERVER_APK"
	bridgeDataDirEnvVar           = "YEP_ANYWHERE_DATA_DIR"
	androidConnectTimeout         = 12 * time.Second
	androidDialAttemptTimeout     = 1500 * time.Millisecond
	androidHandshakeTimeout       = 2 * time.Second
	androidRetryDelay             = 200 * time.Millisecond
	defaultStreamBitrateBps       = 2_000_000
	defaultStreamFPS              = 30
	streamStartTimeout            = 1500 * time.Millisecond
	streamReadPollTimeout         = 200 * time.Millisecond
)

// AndroidDevice communicates with the on-device server through an adb-forwarded TCP socket.
type AndroidDevice struct {
	serial  string
	adbPath string

	forwardSpec  string
	serverCmd    *exec.Cmd
	serverCancel context.CancelFunc

	rw      io.ReadWriteCloser
	reader  io.Reader
	writer  io.Writer
	closeFn func() error

	width  int32
	height int32

	captureMaxWidth int

	writeMu   sync.Mutex
	closeOnce sync.Once
	closeErr  error

	streamMu     sync.Mutex
	streaming    bool
	streamStopCh chan struct{}
	streamDoneCh chan struct{}
	nalSource    *NalSource
	startedCh    chan struct{}
	statusCh     chan streamStatus
}

type streamStatus struct {
	Cmd   string `json:"cmd"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// NewAndroidDevice pushes/starts the on-device server, sets up adb forwarding,
// and connects to the local forwarded socket.
func NewAndroidDevice(serial, adbPath string) (*AndroidDevice, error) {
	serial = strings.TrimSpace(serial)
	if serial == "" {
		return nil, fmt.Errorf("android serial is required")
	}
	if strings.TrimSpace(adbPath) == "" {
		adbPath = defaultADBPath
	}

	apkPath, err := resolveAndroidServerAPKPath()
	if err != nil {
		return nil, err
	}

	if out, err := exec.Command(adbPath, "-s", serial, "push", apkPath, defaultAndroidServerRemoteAPK).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("adb push server apk for %s: %w (%s)", serial, err, strings.TrimSpace(string(out)))
	}

	// Best-effort cleanup from previous runs.
	_, _ = exec.Command(adbPath, "-s", serial, "shell", "pkill -f "+defaultAndroidServerMainClass).CombinedOutput()

	serverCmd, serverCancel, err := startAndroidServer(adbPath, serial)
	if err != nil {
		return nil, err
	}

	forwardSpec := fmt.Sprintf("tcp:%d", defaultAndroidBridgePort)
	_, _ = exec.Command(adbPath, "-s", serial, "forward", "--remove", forwardSpec).CombinedOutput()
	if out, err := exec.Command(adbPath, "-s", serial, "forward", forwardSpec, forwardSpec).CombinedOutput(); err != nil {
		serverCancel()
		_ = waitForProcessExit(serverCmd, 1*time.Second)
		return nil, fmt.Errorf("adb forward for %s: %w (%s)", serial, err, strings.TrimSpace(string(out)))
	}

	conn, width, height, err := connectWithHandshakeRetry(
		androidConnectTimeout,
		androidDialAttemptTimeout,
		androidHandshakeTimeout,
		androidRetryDelay,
		dialForwardedAndroidSocket,
	)
	if err != nil {
		_ = exec.Command(adbPath, "-s", serial, "forward", "--remove", forwardSpec).Run()
		serverCancel()
		_ = waitForProcessExit(serverCmd, 1*time.Second)
		return nil, fmt.Errorf("connect to adb-forwarded socket for %s: %w", serial, err)
	}

	d := &AndroidDevice{
		serial:       serial,
		adbPath:      adbPath,
		forwardSpec:  forwardSpec,
		serverCmd:    serverCmd,
		serverCancel: serverCancel,
		rw:           conn,
		reader:       conn,
		writer:       conn,
		width:        width,
		height:       height,
	}
	return d, nil
}

func startAndroidServer(adbPath, serial string) (*exec.Cmd, context.CancelFunc, error) {
	ctx, cancel := context.WithCancel(context.Background())
	shellCmd := fmt.Sprintf("CLASSPATH=%s app_process /system/bin %s", defaultAndroidServerRemoteAPK, defaultAndroidServerMainClass)
	cmd := exec.CommandContext(ctx, adbPath, "-s", serial, "shell", shellCmd)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, nil, fmt.Errorf("start android device server for %s: %w", serial, err)
	}
	return cmd, cancel, nil
}

func dialForwardedAndroidSocket(timeout time.Duration) (net.Conn, error) {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", defaultAndroidBridgePort), 750*time.Millisecond)
		if err == nil {
			return conn, nil
		}
		lastErr = err
		time.Sleep(200 * time.Millisecond)
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("dial timeout")
	}
	return nil, lastErr
}

func connectWithHandshakeRetry(
	totalTimeout time.Duration,
	dialTimeout time.Duration,
	handshakeTimeout time.Duration,
	retryDelay time.Duration,
	dialFn func(time.Duration) (net.Conn, error),
) (net.Conn, int32, int32, error) {
	deadline := time.Now().Add(totalTimeout)
	var lastErr error

	for time.Now().Before(deadline) {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}

		conn, err := dialFn(minDuration(dialTimeout, remaining))
		if err != nil {
			lastErr = fmt.Errorf("dial: %w", err)
			time.Sleep(minDuration(retryDelay, remaining))
			continue
		}

		_ = conn.SetReadDeadline(time.Now().Add(handshakeTimeout))
		width, height, err := readHandshakeDimensions(conn)
		_ = conn.SetReadDeadline(time.Time{})
		if err == nil {
			return conn, width, height, nil
		}

		lastErr = err
		_ = conn.Close()
		time.Sleep(minDuration(retryDelay, remaining))
	}

	if lastErr == nil {
		lastErr = fmt.Errorf("timed out waiting for android server")
	}
	return nil, 0, 0, fmt.Errorf("read handshake: %w", lastErr)
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func resolveAndroidServerAPKPath() (string, error) {
	if envPath := strings.TrimSpace(os.Getenv(androidServerAPKEnvVar)); envPath != "" {
		if _, err := os.Stat(envPath); err != nil {
			return "", fmt.Errorf("%s is set but file does not exist: %s", androidServerAPKEnvVar, envPath)
		}
		return envPath, nil
	}

	candidates := make([]string, 0, 6)

	if dataDir := strings.TrimSpace(os.Getenv(bridgeDataDirEnvVar)); dataDir != "" {
		candidates = append(candidates, filepath.Join(dataDir, "bin", "yep-device-server.apk"))
	}

	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(exeDir, "yep-device-server.apk"),
			filepath.Join(exeDir, "..", "android-device-server", "app", "build", "outputs", "apk", "release", "yep-device-server.apk"),
			filepath.Join(exeDir, "..", "..", "android-device-server", "app", "build", "outputs", "apk", "release", "yep-device-server.apk"),
		)
	}

	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(cwd, "packages", "android-device-server", "app", "build", "outputs", "apk", "release", "yep-device-server.apk"),
			filepath.Join(cwd, "app", "build", "outputs", "apk", "release", "yep-device-server.apk"),
		)
	}

	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates, filepath.Join(home, ".yep-anywhere", "bin", "yep-device-server.apk"))
	}

	for _, p := range candidates {
		if p == "" {
			continue
		}
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}

	return "", fmt.Errorf(
		"android device server apk not found; set %s or build packages/android-device-server/app/build/outputs/apk/release/yep-device-server.apk",
		androidServerAPKEnvVar,
	)
}

func waitForProcessExit(cmd *exec.Cmd, timeout time.Duration) error {
	if cmd == nil {
		return nil
	}
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	select {
	case err := <-done:
		return err
	case <-time.After(timeout):
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		<-done
		return nil
	}
}

// NewAndroidDeviceWithTransport creates an AndroidDevice over an existing transport.
// Intended for tests and dependency injection.
func NewAndroidDeviceWithTransport(
	serial string,
	rw io.ReadWriteCloser,
	closeFn func() error,
) (*AndroidDevice, error) {
	serial = strings.TrimSpace(serial)
	if serial == "" {
		serial = "android"
	}
	d := &AndroidDevice{
		serial:  serial,
		rw:      rw,
		reader:  rw,
		writer:  rw,
		closeFn: closeFn,
	}
	if err := d.readHandshake(); err != nil {
		_ = d.Close()
		return nil, err
	}
	return d, nil
}

func (d *AndroidDevice) readHandshake() error {
	width, height, err := readHandshakeDimensions(d.reader)
	if err != nil {
		return fmt.Errorf("read handshake: %w", err)
	}
	d.width = width
	d.height = height
	return nil
}

func readHandshakeDimensions(reader io.Reader) (int32, int32, error) {
	var buf [4]byte
	if _, err := io.ReadFull(reader, buf[:]); err != nil {
		return 0, 0, err
	}
	return int32(binary.LittleEndian.Uint16(buf[:2])), int32(binary.LittleEndian.Uint16(buf[2:4])), nil
}

// StartStream enables push-based H.264 streaming on supported device-server builds.
// Older servers ignore stream commands; this method times out and returns an error,
// allowing callers to fall back to GetFrame()+x264.
func (d *AndroidDevice) StartStream(ctx context.Context, opts StreamOptions) (*NalSource, error) {
	d.streamMu.Lock()
	if d.streaming && d.nalSource != nil {
		source := d.nalSource
		d.streamMu.Unlock()
		return source, nil
	}

	width := opts.Width
	height := opts.Height
	if width <= 0 || height <= 0 {
		sw, sh := d.ScreenSize()
		width = int(sw)
		height = int(sh)
	}
	if width <= 0 {
		width = 720
	}
	if height <= 0 {
		height = 1280
	}

	bitrate := opts.BitrateBps
	if bitrate <= 0 {
		bitrate = defaultStreamBitrateBps
	}
	fps := opts.FPS
	if fps <= 0 {
		fps = defaultStreamFPS
	}

	d.streamStopCh = make(chan struct{})
	d.streamDoneCh = make(chan struct{})
	d.startedCh = make(chan struct{})
	d.statusCh = make(chan streamStatus, 4)
	d.nalSource = NewNalSource()
	d.streaming = true
	d.streamMu.Unlock()

	payload, err := json.Marshal(struct {
		Cmd     string `json:"cmd"`
		Width   int    `json:"width"`
		Height  int    `json:"height"`
		Bitrate int    `json:"bitrate"`
		FPS     int    `json:"fps"`
	}{
		Cmd:     "stream_start",
		Width:   width,
		Height:  height,
		Bitrate: bitrate,
		FPS:     fps,
	})
	if err != nil {
		_ = d.StopStream(context.Background())
		return nil, fmt.Errorf("marshal stream_start payload: %w", err)
	}
	if err := d.writeControl(payload); err != nil {
		_ = d.StopStream(context.Background())
		return nil, fmt.Errorf("send stream_start: %w", err)
	}

	go d.runStreamReader(d.streamStopCh, d.streamDoneCh, d.nalSource, d.startedCh, d.statusCh)

	timeout := streamStartTimeout
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline); remaining > 0 && remaining < timeout {
			timeout = remaining
		}
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			_ = d.StopStream(context.Background())
			return nil, ctx.Err()
		case st := <-d.statusCh:
			if st.Cmd == "stream_start" {
				if !st.OK {
					_ = d.StopStream(context.Background())
					if st.Error == "" {
						st.Error = "stream_start rejected"
					}
					return nil, errors.New(st.Error)
				}
				return d.nalSource, nil
			}
		case <-d.startedCh:
			return d.nalSource, nil
		case <-timer.C:
			_ = d.StopStream(context.Background())
			return nil, fmt.Errorf("stream start timed out (device server may be legacy)")
		}
	}
}

// StopStream disables push-based streaming.
func (d *AndroidDevice) StopStream(ctx context.Context) error {
	_ = ctx

	d.streamMu.Lock()
	if !d.streaming {
		d.streamMu.Unlock()
		return nil
	}
	stopCh := d.streamStopCh
	doneCh := d.streamDoneCh
	nalSource := d.nalSource
	d.streaming = false
	d.streamStopCh = nil
	d.streamDoneCh = nil
	d.nalSource = nil
	d.startedCh = nil
	d.statusCh = nil
	d.streamMu.Unlock()

	// Best effort: if the server supports stream controls, request clean stop.
	payload, _ := json.Marshal(struct {
		Cmd string `json:"cmd"`
	}{Cmd: "stream_stop"})
	_ = d.writeControl(payload)

	if stopCh != nil {
		close(stopCh)
	}
	if doneCh != nil {
		select {
		case <-doneCh:
		case <-time.After(1 * time.Second):
		}
	}
	if nalSource != nil {
		nalSource.Stop()
	}
	return nil
}

func (d *AndroidDevice) SetStreamBitrate(ctx context.Context, bps int) error {
	_ = ctx
	if bps <= 0 {
		return nil
	}
	payload, err := json.Marshal(struct {
		Cmd string `json:"cmd"`
		Bps int    `json:"bps"`
	}{
		Cmd: "stream_bitrate",
		Bps: bps,
	})
	if err != nil {
		return fmt.Errorf("marshal stream_bitrate payload: %w", err)
	}
	return d.writeControl(payload)
}

func (d *AndroidDevice) RequestStreamKeyframe(ctx context.Context) error {
	_ = ctx
	payload, err := json.Marshal(struct {
		Cmd string `json:"cmd"`
	}{Cmd: "stream_keyframe"})
	if err != nil {
		return fmt.Errorf("marshal stream_keyframe payload: %w", err)
	}
	return d.writeControl(payload)
}

type readDeadliner interface {
	SetReadDeadline(time.Time) error
}

func (d *AndroidDevice) runStreamReader(
	stopCh <-chan struct{},
	doneCh chan<- struct{},
	nalSource *NalSource,
	startedCh chan struct{},
	statusCh chan<- streamStatus,
) {
	defer close(doneCh)

	started := false
	for {
		select {
		case <-stopCh:
			return
		default:
		}

		if rd, ok := d.rw.(readDeadliner); ok {
			_ = rd.SetReadDeadline(time.Now().Add(streamReadPollTimeout))
		}
		msgType, err := d.readStreamTypeByte()
		if rd, ok := d.rw.(readDeadliner); ok {
			_ = rd.SetReadDeadline(time.Time{})
		}
		if err != nil {
			if isTimeoutError(err) {
				continue
			}
			if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
				log.Printf("[AndroidDevice] stream reader error: %v", err)
			}
			return
		}

		switch msgType {
		case conn.TypeStreamStatus:
			msg, err := d.readLengthPrefixedPayload()
			if err != nil {
				log.Printf("[AndroidDevice] read stream status: %v", err)
				return
			}
			var st streamStatus
			if err := json.Unmarshal(msg, &st); err != nil {
				log.Printf("[AndroidDevice] bad stream status JSON: %v", err)
				continue
			}
			select {
			case statusCh <- st:
			default:
			}
		case conn.TypeStreamNAL:
			nal, err := conn.ReadStreamNALBody(d.reader)
			if err != nil {
				log.Printf("[AndroidDevice] read stream NAL: %v", err)
				return
			}
			unit := &NalUnit{
				Data:     nal.Data,
				Keyframe: (nal.Flags & 0x01) != 0,
				Config:   (nal.Flags & 0x02) != 0,
				PTSUs:    int64(nal.PTSUs),
			}
			nalSource.Publish(unit)
			if !started {
				started = true
				close(startedCh)
			}
		default:
			// Ignore unrelated packets while streaming (legacy frame/control traffic).
			if msgType == conn.TypeFrameResponse ||
				msgType == conn.TypeControl ||
				msgType == conn.TypeStreamStatus {
				if _, err := d.readLengthPrefixedPayload(); err != nil {
					log.Printf("[AndroidDevice] drain payload for type 0x%02x: %v", msgType, err)
					return
				}
				continue
			}
			log.Printf("[AndroidDevice] unknown stream packet type: 0x%02x", msgType)
		}
	}
}

func (d *AndroidDevice) readStreamTypeByte() (byte, error) {
	var typeBuf [1]byte
	if _, err := io.ReadFull(d.reader, typeBuf[:]); err != nil {
		return 0, err
	}
	return typeBuf[0], nil
}

func (d *AndroidDevice) readLengthPrefixedPayload() ([]byte, error) {
	var lenBuf [4]byte
	if _, err := io.ReadFull(d.reader, lenBuf[:]); err != nil {
		return nil, err
	}
	payloadLen := binary.LittleEndian.Uint32(lenBuf[:])
	payload := make([]byte, payloadLen)
	if _, err := io.ReadFull(d.reader, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func isTimeoutError(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

// GetFrame requests a frame and decodes the returned JPEG into RGB888.
func (d *AndroidDevice) GetFrame(ctx context.Context, maxWidth int) (*Frame, error) {
	_ = ctx

	d.streamMu.Lock()
	streaming := d.streaming
	d.streamMu.Unlock()
	if streaming {
		return nil, fmt.Errorf("GetFrame unavailable while stream mode is active")
	}

	d.writeMu.Lock()
	if err := d.applyCaptureSettingsLocked(maxWidth); err != nil {
		d.writeMu.Unlock()
		return nil, err
	}
	err := conn.WriteFrameRequest(d.writer)
	d.writeMu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("write frame request: %w", err)
	}

	msgType, payload, err := conn.ReadMessage(d.reader)
	if err != nil {
		return nil, fmt.Errorf("read frame response: %w", err)
	}
	if msgType != conn.TypeFrameResponse {
		return nil, fmt.Errorf("unexpected message type: 0x%02x", msgType)
	}

	rgb, width, height, err := decodeJPEGToRGB(payload)
	if err != nil {
		return nil, err
	}
	d.width = int32(width)
	d.height = int32(height)

	return &Frame{
		Data:   rgb,
		Width:  int32(width),
		Height: int32(height),
	}, nil
}

func normalizeCaptureMaxWidth(maxWidth int) int {
	if maxWidth <= 0 {
		return 0
	}
	const minCaptureWidth = 64
	const maxCaptureWidth = 4096
	if maxWidth < minCaptureWidth {
		return minCaptureWidth
	}
	if maxWidth > maxCaptureWidth {
		return maxCaptureWidth
	}
	return maxWidth
}

func (d *AndroidDevice) applyCaptureSettingsLocked(maxWidth int) error {
	requested := normalizeCaptureMaxWidth(maxWidth)
	if requested == d.captureMaxWidth {
		return nil
	}

	payload, err := json.Marshal(struct {
		Cmd      string `json:"cmd"`
		MaxWidth int    `json:"maxWidth"`
	}{
		Cmd:      "capture_settings",
		MaxWidth: requested,
	})
	if err != nil {
		return fmt.Errorf("marshal capture settings payload: %w", err)
	}

	if err := conn.WriteControl(d.writer, payload); err != nil {
		return fmt.Errorf("write capture settings: %w", err)
	}
	d.captureMaxWidth = requested
	return nil
}

// SendTouch forwards touch control to the Android device server.
func (d *AndroidDevice) SendTouch(ctx context.Context, touches []TouchPoint) error {
	_ = ctx

	payload, err := json.Marshal(struct {
		Cmd     string       `json:"cmd"`
		Touches []TouchPoint `json:"touches"`
	}{
		Cmd:     "touch",
		Touches: touches,
	})
	if err != nil {
		return fmt.Errorf("marshal touch payload: %w", err)
	}
	return d.writeControl(payload)
}

// SendKey forwards key control to the Android device server.
func (d *AndroidDevice) SendKey(ctx context.Context, key string) error {
	_ = ctx

	payload, err := json.Marshal(struct {
		Cmd string `json:"cmd"`
		Key string `json:"key"`
	}{
		Cmd: "key",
		Key: key,
	})
	if err != nil {
		return fmt.Errorf("marshal key payload: %w", err)
	}
	return d.writeControl(payload)
}

func (d *AndroidDevice) writeControl(payload []byte) error {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	if err := conn.WriteControl(d.writer, payload); err != nil {
		return fmt.Errorf("write control: %w", err)
	}
	return nil
}

// ScreenSize returns the last known screen size.
func (d *AndroidDevice) ScreenSize() (width, height int32) {
	return d.width, d.height
}

// Close shuts down the device transport.
func (d *AndroidDevice) Close() error {
	d.closeOnce.Do(func() {
		var firstErr error
		setErr := func(err error) {
			if err != nil && firstErr == nil {
				firstErr = err
			}
		}

		if err := d.StopStream(context.Background()); err != nil {
			setErr(err)
		}

		if d.rw != nil {
			setErr(d.rw.Close())
		}

		if d.serverCancel != nil {
			d.serverCancel()
		}
		if d.serverCmd != nil {
			_ = waitForProcessExit(d.serverCmd, 1500*time.Millisecond)
		}

		if d.adbPath != "" && d.serial != "" && d.forwardSpec != "" {
			if _, err := exec.Command(d.adbPath, "-s", d.serial, "forward", "--remove", d.forwardSpec).CombinedOutput(); err != nil {
				setErr(err)
			}
		}

		if d.closeFn != nil {
			setErr(d.closeFn())
		}

		d.closeErr = firstErr
	})
	return d.closeErr
}
