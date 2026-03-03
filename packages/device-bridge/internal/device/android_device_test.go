package device

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/anthropics/yepanywhere/device-bridge/internal/conn"
)

func TestAndroidDeviceWithMockTCPServer(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	done := make(chan error, 1)
	go func() {
		srvConn, err := ln.Accept()
		if err != nil {
			done <- err
			return
		}
		defer srvConn.Close()

		var handshake [4]byte
		binary.LittleEndian.PutUint16(handshake[:2], 2)
		binary.LittleEndian.PutUint16(handshake[2:], 1)
		if _, err := srvConn.Write(handshake[:]); err != nil {
			done <- err
			return
		}

		controlPayloads := make([]string, 0, 2)
		for len(controlPayloads) < 2 {
			msgType, payload, err := conn.ReadMessage(srvConn)
			if err != nil {
				done <- err
				return
			}

			switch msgType {
			case conn.TypeFrameRequest:
				if err := conn.WriteFrameResponse(srvConn, testJPEG(2, 1)); err != nil {
					done <- err
					return
				}
			case conn.TypeControl:
				controlPayloads = append(controlPayloads, string(payload))
			default:
				done <- errUnexpectedMessageType(msgType)
				return
			}
		}

		if !strings.Contains(controlPayloads[0], `"cmd":"key"`) &&
			!strings.Contains(controlPayloads[1], `"cmd":"key"`) {
			done <- errString("missing key control payload")
			return
		}
		if !strings.Contains(controlPayloads[0], `"cmd":"touch"`) &&
			!strings.Contains(controlPayloads[1], `"cmd":"touch"`) {
			done <- errString("missing touch control payload")
			return
		}

		done <- nil
	}()

	clientConn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer clientConn.Close()

	d, err := NewAndroidDeviceWithTransport("R3CN90ABCDE", clientConn, nil)
	if err != nil {
		t.Fatalf("new device: %v", err)
	}
	defer d.Close()

	w, h := d.ScreenSize()
	if w != 2 || h != 1 {
		t.Fatalf("unexpected handshake dimensions: %dx%d", w, h)
	}

	frame, err := d.GetFrame(context.Background(), 0)
	if err != nil {
		t.Fatalf("GetFrame: %v", err)
	}
	if frame.Width != 2 || frame.Height != 1 {
		t.Fatalf("unexpected frame dimensions: %dx%d", frame.Width, frame.Height)
	}
	if len(frame.Data) != 6 {
		t.Fatalf("expected RGB frame length 6, got %d", len(frame.Data))
	}

	if err := d.SendKey(context.Background(), "back"); err != nil {
		t.Fatalf("SendKey: %v", err)
	}
	if err := d.SendTouch(context.Background(), []TouchPoint{{X: 0.25, Y: 0.5, Pressure: 1.0}}); err != nil {
		t.Fatalf("SendTouch: %v", err)
	}

	select {
	case err := <-done:
		if err != nil && err != io.EOF {
			t.Fatalf("mock server goroutine: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for mock server goroutine")
	}
}

func TestAndroidDeviceAppliesCaptureSettingsOnMaxWidthChange(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()

	done := make(chan error, 1)
	go func() {
		defer close(done)

		var handshake [4]byte
		binary.LittleEndian.PutUint16(handshake[:2], 1080)
		binary.LittleEndian.PutUint16(handshake[2:], 2400)
		if _, err := serverConn.Write(handshake[:]); err != nil {
			done <- err
			return
		}

		expectCaptureSettings := func(width int) error {
			msgType, payload, err := conn.ReadMessage(serverConn)
			if err != nil {
				return err
			}
			if msgType != conn.TypeControl {
				return errUnexpectedMessageType(msgType)
			}
			raw := string(payload)
			if !strings.Contains(raw, `"cmd":"capture_settings"`) {
				return errString("missing capture_settings control payload")
			}
			if !strings.Contains(raw, `"maxWidth":`+fmt.Sprintf("%d", width)) {
				return errString("unexpected capture maxWidth payload: " + raw)
			}
			return nil
		}

		expectFrameRequestThenRespond := func() error {
			msgType, _, err := conn.ReadMessage(serverConn)
			if err != nil {
				return err
			}
			if msgType != conn.TypeFrameRequest {
				return errUnexpectedMessageType(msgType)
			}
			return conn.WriteFrameResponse(serverConn, testJPEG(2, 1))
		}

		if err := expectCaptureSettings(360); err != nil {
			done <- err
			return
		}
		if err := expectFrameRequestThenRespond(); err != nil {
			done <- err
			return
		}

		// Same maxWidth should not resend capture_settings.
		if err := expectFrameRequestThenRespond(); err != nil {
			done <- err
			return
		}

		if err := expectCaptureSettings(540); err != nil {
			done <- err
			return
		}
		if err := expectFrameRequestThenRespond(); err != nil {
			done <- err
			return
		}

		done <- nil
	}()

	d, err := NewAndroidDeviceWithTransport("R3CN90ABCDE", clientConn, nil)
	if err != nil {
		t.Fatalf("new device: %v", err)
	}
	defer d.Close()

	if _, err := d.GetFrame(context.Background(), 360); err != nil {
		t.Fatalf("GetFrame(360): %v", err)
	}
	if _, err := d.GetFrame(context.Background(), 360); err != nil {
		t.Fatalf("GetFrame(360) second: %v", err)
	}
	if _, err := d.GetFrame(context.Background(), 540); err != nil {
		t.Fatalf("GetFrame(540): %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("mock server goroutine: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for mock server goroutine")
	}
}

func TestResolveAndroidServerAPKPathUsesBridgeDataDirEnv(t *testing.T) {
	tmpDir := t.TempDir()
	apkPath := filepath.Join(tmpDir, "bin", "yep-device-server.apk")
	if err := os.MkdirAll(filepath.Dir(apkPath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(apkPath, []byte("apk"), 0o644); err != nil {
		t.Fatalf("write apk: %v", err)
	}

	t.Setenv(androidServerAPKEnvVar, "")
	t.Setenv(bridgeDataDirEnvVar, tmpDir)

	resolved, err := resolveAndroidServerAPKPath()
	if err != nil {
		t.Fatalf("resolve apk path: %v", err)
	}
	if resolved != apkPath {
		t.Fatalf("expected %s, got %s", apkPath, resolved)
	}
}

func TestConnectWithHandshakeRetryRecoversAfterInitialEOF(t *testing.T) {
	attempts := 0
	dialFn := func(_ time.Duration) (net.Conn, error) {
		attempts++
		client, server := net.Pipe()

		switch attempts {
		case 1:
			_ = server.Close()
		default:
			go func() {
				defer server.Close()
				var handshake [4]byte
				binary.LittleEndian.PutUint16(handshake[:2], 1080)
				binary.LittleEndian.PutUint16(handshake[2:], 2340)
				_, _ = server.Write(handshake[:])
			}()
		}

		return client, nil
	}

	conn, width, height, err := connectWithHandshakeRetry(
		2*time.Second,
		200*time.Millisecond,
		500*time.Millisecond,
		10*time.Millisecond,
		dialFn,
	)
	if err != nil {
		t.Fatalf("connectWithHandshakeRetry: %v", err)
	}
	defer conn.Close()

	if attempts < 2 {
		t.Fatalf("expected at least 2 attempts, got %d", attempts)
	}
	if width != 1080 || height != 2340 {
		t.Fatalf("unexpected handshake dimensions: %dx%d", width, height)
	}
}

func TestAndroidDeviceStartStreamFallsBackToGetFrameOnLegacyServer(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()

	done := make(chan error, 1)
	go func() {
		defer close(done)
		defer serverConn.Close()

		var handshake [4]byte
		binary.LittleEndian.PutUint16(handshake[:2], 1080)
		binary.LittleEndian.PutUint16(handshake[2:], 2340)
		if _, err := serverConn.Write(handshake[:]); err != nil {
			done <- err
			return
		}

		// Legacy behavior: stream_start command is accepted as generic control but no response/NALs.
		msgType, payload, err := conn.ReadMessage(serverConn)
		if err != nil {
			done <- err
			return
		}
		if msgType != conn.TypeControl || !strings.Contains(string(payload), `"cmd":"stream_start"`) {
			done <- errString("expected stream_start control")
			return
		}

		// Client should timeout and send stream_stop best-effort.
		msgType, payload, err = conn.ReadMessage(serverConn)
		if err != nil {
			done <- err
			return
		}
		if msgType != conn.TypeControl || !strings.Contains(string(payload), `"cmd":"stream_stop"`) {
			done <- errString("expected stream_stop control")
			return
		}

		msgType, _, err = conn.ReadMessage(serverConn)
		if err != nil {
			done <- err
			return
		}
		if msgType != conn.TypeFrameRequest {
			done <- errUnexpectedMessageType(msgType)
			return
		}
		if err := conn.WriteFrameResponse(serverConn, testJPEG(2, 1)); err != nil {
			done <- err
			return
		}

		done <- nil
	}()

	d, err := NewAndroidDeviceWithTransport("R3CN90ABCDE", clientConn, nil)
	if err != nil {
		t.Fatalf("new device: %v", err)
	}
	defer d.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if _, err := d.StartStream(ctx, StreamOptions{Width: 720, Height: 1280, FPS: 30, BitrateBps: 2_000_000}); err == nil {
		t.Fatal("expected StartStream to fail on legacy server")
	}

	if _, err := d.GetFrame(context.Background(), 0); err != nil {
		t.Fatalf("GetFrame after stream fallback: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("mock server goroutine: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for mock server goroutine")
	}
}

func TestAndroidDeviceStartStreamReceivesNALOnSupportedServer(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()

	done := make(chan error, 1)
	go func() {
		defer close(done)
		defer serverConn.Close()

		var handshake [4]byte
		binary.LittleEndian.PutUint16(handshake[:2], 1080)
		binary.LittleEndian.PutUint16(handshake[2:], 2340)
		if _, err := serverConn.Write(handshake[:]); err != nil {
			done <- err
			return
		}

		msgType, payload, err := conn.ReadMessage(serverConn)
		if err != nil {
			done <- err
			return
		}
		if msgType != conn.TypeControl || !strings.Contains(string(payload), `"cmd":"stream_start"`) {
			done <- errString("expected stream_start control")
			return
		}

		if err := conn.WriteStreamStatus(serverConn, []byte(`{"cmd":"stream_start","ok":true}`)); err != nil {
			done <- err
			return
		}

		// Give subscriber setup a moment before first NAL.
		time.Sleep(50 * time.Millisecond)
		if err := conn.WriteStreamNAL(
			serverConn,
			0x03,
			123_456,
			[]byte{0x00, 0x00, 0x00, 0x01, 0x65, 0x88},
		); err != nil {
			done <- err
			return
		}

		msgType, payload, err = conn.ReadMessage(serverConn)
		if err != nil {
			done <- err
			return
		}
		if msgType != conn.TypeControl || !strings.Contains(string(payload), `"cmd":"stream_stop"`) {
			done <- errString("expected stream_stop control")
			return
		}

		done <- nil
	}()

	d, err := NewAndroidDeviceWithTransport("R3CN90ABCDE", clientConn, nil)
	if err != nil {
		t.Fatalf("new device: %v", err)
	}
	defer d.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	source, err := d.StartStream(ctx, StreamOptions{Width: 720, Height: 1280, FPS: 30, BitrateBps: 2_000_000})
	if err != nil {
		t.Fatalf("StartStream: %v", err)
	}

	id, ch := source.Subscribe()
	defer source.Unsubscribe(id)

	select {
	case unit := <-ch:
		if unit == nil {
			t.Fatal("expected NAL unit, got nil")
		}
		if !unit.Keyframe || !unit.Config {
			t.Fatalf("expected keyframe+config flags, got keyframe=%v config=%v", unit.Keyframe, unit.Config)
		}
		if unit.PTSUs != 123_456 {
			t.Fatalf("unexpected pts: %d", unit.PTSUs)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("timeout waiting for NAL unit")
	}

	if err := d.StopStream(context.Background()); err != nil {
		t.Fatalf("StopStream: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("mock server goroutine: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for mock server goroutine")
	}
}
