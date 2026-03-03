package ipc

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/anthropics/yepanywhere/device-bridge/internal/device"
	"github.com/anthropics/yepanywhere/device-bridge/internal/encoder"
	"github.com/anthropics/yepanywhere/device-bridge/internal/stream"
)

// SessionStartOptions are the options for starting a device streaming session.
type SessionStartOptions struct {
	MaxFPS   int `json:"maxFps"`
	MaxWidth int `json:"maxWidth"`
	Quality  int `json:"quality"` // x264 CRF value (0 = use default of 30)
}

// streamSession holds the state for a single active device streaming session.
type streamSession struct {
	sessionID   string
	deviceID    string
	maxWidth    int // for pool release key
	maxFPS      int
	frameSource *device.FrameSource // shared via pool, not owned
	nalSource   *device.NalSource
	streamCap   device.StreamCapable
	enc         *encoder.H264Encoder
	peer        *stream.PeerSession
	input       *stream.InputHandler
	cancel      context.CancelFunc
	targetW     int
	targetH     int
	pipelineWg  sync.WaitGroup // tracks runPipeline goroutine lifetime
	fpsCh       chan int       // receives fps_hint values from the client DataChannel
}

// SessionManager manages multiple concurrent device streaming sessions.
type SessionManager struct {
	mu          sync.Mutex
	sessions    map[string]*streamSession
	stunServers []string
	sendMsg     func(msg []byte) // send JSON to the Yep server WebSocket
	pool        *ResourcePool    // shared device connections and FrameSources
	onIdle      func()           // called when no sessions remain for idleTimeout
	idleTimer   *time.Timer
	idleTimeout time.Duration
}

// NewSessionManager creates a session manager.
// onIdle is called when no sessions remain for 10 seconds (nil to disable).
func NewSessionManager(adbPath string, stunServers []string, sendMsg func(msg []byte), onIdle func()) *SessionManager {
	sm := &SessionManager{
		sessions:    make(map[string]*streamSession),
		stunServers: stunServers,
		sendMsg:     sendMsg,
		pool:        NewResourcePool(adbPath),
		onIdle:      onIdle,
		idleTimeout: 10 * time.Second,
	}
	// Start idle timer immediately (bridge starts with no sessions).
	if onIdle != nil {
		sm.idleTimer = time.AfterFunc(sm.idleTimeout, sm.handleIdle)
	}
	return sm
}

// handleIdle fires when the idle timer expires. Only triggers onIdle if still no sessions.
func (sm *SessionManager) handleIdle() {
	sm.mu.Lock()
	count := len(sm.sessions)
	sm.mu.Unlock()

	if count == 0 && sm.onIdle != nil {
		log.Printf("[SessionManager] idle for %v with no sessions, triggering shutdown", sm.idleTimeout)
		sm.onIdle()
	}
}

// resetIdleTimer must be called with sm.mu held.
func (sm *SessionManager) resetIdleTimer() {
	if sm.idleTimer == nil {
		return
	}
	if len(sm.sessions) > 0 {
		sm.idleTimer.Stop()
	} else {
		sm.idleTimer.Reset(sm.idleTimeout)
	}
}

// StartSession creates a new streaming session for the given device.
func (sm *SessionManager) StartSession(sessionID, deviceID, deviceType string, opts SessionStartOptions) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Close existing session with same ID.
	if existing, ok := sm.sessions[sessionID]; ok {
		sm.closeSessionLocked(existing)
	}

	sm.sendState(sessionID, "connecting", "")

	// Defaults.
	maxWidth := opts.MaxWidth
	if maxWidth <= 0 {
		maxWidth = 360
	}
	maxFPS := opts.MaxFPS
	if maxFPS <= 0 {
		maxFPS = 30
	}

	// Acquire shared device from pool.
	log.Printf("[session %s] connecting to device %s (type=%s)", sessionID, deviceID, deviceType)

	client, err := sm.pool.AcquireDevice(deviceID, deviceType)
	if err != nil {
		sm.sendState(sessionID, "failed", fmt.Sprintf("device connect: %v", err))
		return fmt.Errorf("connecting to device: %w", err)
	}

	srcW, srcH := client.ScreenSize()
	targetW, targetH := encoder.ComputeTargetSize(int(srcW), int(srcH), maxWidth)
	log.Printf("[session %s] screen %dx%d → encoding %dx%d", sessionID, srcW, srcH, targetW, targetH)

	var (
		frameSource *device.FrameSource
		nalSource   *device.NalSource
		streamCap   device.StreamCapable
		h264Enc     *encoder.H264Encoder
	)

	// Try Android hardware stream path first; fall back to JPEG+x264 on any failure.
	if strings.EqualFold(deviceType, "android") {
		if sc, ok := client.(device.StreamCapable); ok {
			streamOpts := device.StreamOptions{
				Width:      targetW,
				Height:     targetH,
				FPS:        maxFPS,
				BitrateBps: estimateAndroidBitrate(targetW, targetH, maxFPS),
			}
			if ns, streamErr := sc.StartStream(context.Background(), streamOpts); streamErr == nil {
				nalSource = ns
				streamCap = sc
				log.Printf("[session %s] using on-device MediaCodec stream (%dx%d @ %dfps)", sessionID, targetW, targetH, maxFPS)
			} else {
				log.Printf("[session %s] stream_start unavailable, falling back to screenshot path: %v", sessionID, streamErr)
			}
		}
	}

	if nalSource == nil {
		h264Enc, err = encoder.NewH264Encoder(targetW, targetH, maxFPS, opts.Quality)
		if err != nil {
			sm.pool.ReleaseDevice(deviceID)
			sm.sendState(sessionID, "failed", fmt.Sprintf("encoder: %v", err))
			return fmt.Errorf("creating encoder: %w", err)
		}
		// Acquire shared FrameSource from pool only on screenshot mode.
		frameSource = sm.pool.AcquireFrameSource(deviceID, maxWidth, maxFPS, client)
	}

	inputHandler := stream.NewInputHandler(client)

	fpsCh := make(chan int, 1)

	// Wrap the DataChannel handler to intercept fps_hint messages before
	// forwarding everything else to the input handler.
	type fpshintMsg struct {
		Type string `json:"type"`
		FPS  int    `json:"fps"`
	}
	onMessage := func(msg []byte) {
		var peek fpshintMsg
		if json.Unmarshal(msg, &peek) == nil && peek.Type == "fps_hint" {
			if peek.FPS > 0 {
				select {
				case fpsCh <- peek.FPS:
				default: // drop if a hint is already pending
				}
			}
			return
		}
		inputHandler.HandleMessage(msg)
	}

	// Create WebRTC peer with trickle ICE.
	onICE := func(c *stream.ICECandidateJSON) {
		sm.sendICE(sessionID, c)
	}
	peer, err := stream.NewPeerSession(sessionID, sm.stunServers, onMessage, onICE)
	if err != nil {
		if frameSource != nil {
			sm.pool.ReleaseFrameSource(deviceID, maxWidth)
		}
		if h264Enc != nil {
			h264Enc.Close()
		}
		if streamCap != nil {
			_ = streamCap.StopStream(context.Background())
		}
		sm.pool.ReleaseDevice(deviceID)
		sm.sendState(sessionID, "failed", fmt.Sprintf("peer: %v", err))
		return fmt.Errorf("creating peer: %w", err)
	}

	sdp, err := peer.CreateOffer()
	if err != nil {
		peer.Close()
		if frameSource != nil {
			sm.pool.ReleaseFrameSource(deviceID, maxWidth)
		}
		if h264Enc != nil {
			h264Enc.Close()
		}
		if streamCap != nil {
			_ = streamCap.StopStream(context.Background())
		}
		sm.pool.ReleaseDevice(deviceID)
		sm.sendState(sessionID, "failed", fmt.Sprintf("offer: %v", err))
		return fmt.Errorf("creating offer: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	sess := &streamSession{
		sessionID:   sessionID,
		deviceID:    deviceID,
		maxWidth:    maxWidth,
		maxFPS:      maxFPS,
		frameSource: frameSource,
		nalSource:   nalSource,
		streamCap:   streamCap,
		enc:         h264Enc,
		peer:        peer,
		input:       inputHandler,
		cancel:      cancel,
		targetW:     targetW,
		targetH:     targetH,
		fpsCh:       fpsCh,
	}
	sm.sessions[sessionID] = sess
	sm.resetIdleTimer()

	// Monitor peer close.
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[session %s] panic recovered in peer monitor: %v", sessionID, r)
			}
		}()
		select {
		case <-peer.Done():
			sm.mu.Lock()
			if s, ok := sm.sessions[sessionID]; ok && s == sess {
				sm.closeSessionLocked(sess)
				delete(sm.sessions, sessionID)
				sm.resetIdleTimer()
			}
			sm.mu.Unlock()
			sm.sendState(sessionID, "disconnected", "")
		case <-ctx.Done():
		}
	}()

	// Send the offer to the Yep server.
	sm.sendOffer(sessionID, sdp)

	return nil
}

// HandleAnswer processes an SDP answer for a session and starts the encoding pipeline.
func (sm *SessionManager) HandleAnswer(sessionID, sdp string) error {
	sm.mu.Lock()
	sess, ok := sm.sessions[sessionID]
	sm.mu.Unlock()

	if !ok {
		return fmt.Errorf("no session %s", sessionID)
	}

	if err := sess.peer.SetAnswer(sdp); err != nil {
		return fmt.Errorf("setting answer: %w", err)
	}

	// Start encoding pipeline.
	sess.pipelineWg.Add(1)
	go sm.runPipeline(sess)

	sm.sendState(sessionID, "connected", "")
	return nil
}

// HandleICE adds a remote ICE candidate to a session.
func (sm *SessionManager) HandleICE(sessionID string, candidateJSON json.RawMessage) error {
	sm.mu.Lock()
	sess, ok := sm.sessions[sessionID]
	sm.mu.Unlock()

	if !ok {
		return fmt.Errorf("no session %s", sessionID)
	}

	if string(candidateJSON) == "null" {
		// End-of-candidates signal; nothing to do on the Pion side.
		return nil
	}

	return sess.peer.AddICECandidate(candidateJSON)
}

// StopSession tears down a streaming session.
func (sm *SessionManager) StopSession(sessionID string) {
	sm.mu.Lock()
	sess, ok := sm.sessions[sessionID]
	if ok {
		sm.closeSessionLocked(sess)
		delete(sm.sessions, sessionID)
		sm.resetIdleTimer()
	}
	sm.mu.Unlock()

	if ok {
		sm.sendState(sessionID, "disconnected", "")
	}
}

// CloseAll tears down all sessions.
func (sm *SessionManager) CloseAll() {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	for id, sess := range sm.sessions {
		sm.closeSessionLocked(sess)
		delete(sm.sessions, id)
	}
	// Force-close any remaining pool resources (shouldn't be any after closeSessionLocked).
	sm.pool.CloseAll()
	sm.resetIdleTimer()
}

func (sm *SessionManager) closeSessionLocked(sess *streamSession) {
	sess.cancel()
	sess.peer.Close()
	// Wait for the pipeline goroutine to exit before freeing resources.
	sess.pipelineWg.Wait()

	if sess.streamCap != nil {
		_ = sess.streamCap.StopStream(context.Background())
	}
	if sess.enc != nil {
		// The x264 C library will crash (SIGSEGV/SIGABRT) if encoder is freed
		// while a concurrent encode call is in progress.
		sess.enc.Close()
	}
	// Release shared resources via pool (ref-counted).
	if sess.frameSource != nil {
		sm.pool.ReleaseFrameSource(sess.deviceID, sess.maxWidth)
	}
	sm.pool.ReleaseDevice(sess.deviceID)
	log.Printf("[session %s] closed", sess.sessionID)
	// Note: caller must call resetIdleTimer() after deleting from sm.sessions.
}

func (sm *SessionManager) runPipeline(sess *streamSession) {
	defer sess.pipelineWg.Done()
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[session %s] panic recovered in pipeline: %v", sess.sessionID, r)
		}
	}()

	// Wait for WebRTC connection before encoding frames.
	// Frames encoded before the connection is ready are silently dropped by Pion.
	log.Printf("[session %s] pipeline waiting for WebRTC connection", sess.sessionID)
	select {
	case <-sess.peer.Connected():
		log.Printf("[session %s] WebRTC connected, starting pipeline", sess.sessionID)
	case <-sess.peer.Done():
		log.Printf("[session %s] peer closed before connecting", sess.sessionID)
		return
	case <-time.After(30 * time.Second):
		log.Printf("[session %s] WebRTC connection timed out", sess.sessionID)
		return
	}

	if sess.nalSource != nil {
		sm.runNALPipeline(sess)
		return
	}

	id, frames := sess.frameSource.Subscribe()
	defer sess.frameSource.Unsubscribe(id)

	log.Printf("[session %s] pipeline started", sess.sessionID)
	defer log.Printf("[session %s] pipeline stopped", sess.sessionID)

	const activityTimeout = 15 * time.Second
	activityTimer := time.NewTimer(activityTimeout)
	defer activityTimer.Stop()

	// Pipeline stats for diagnostics.
	var (
		lastTime        time.Time
		framesReceived  uint64
		framesDrained   uint64
		framesEncoded   uint64
		framesWritten   uint64
		encodeErrors    uint64
		nilNals         uint64
		totalWriteBytes uint64
		statsStart      = time.Now()
	)

	// Rate-limit encoding to maxFPS. Without this, the polling loop feeds
	// frames as fast as gRPC delivers (~185 fps), producing excessive bitrate.
	currentFPS := sess.maxFPS
	frameInterval := time.Second / time.Duration(currentFPS)
	rateLimiter := time.NewTicker(frameInterval)
	defer rateLimiter.Stop()

	const statsInterval = 5 * time.Second
	statsTicker := time.NewTicker(statsInterval)
	defer statsTicker.Stop()

	logStats := func(reason string) {
		elapsed := time.Since(statsStart).Seconds()
		fps := float64(0)
		if elapsed > 0 {
			fps = float64(framesWritten) / elapsed
		}
		log.Printf("[session %s] stats (%s): recv=%d drained=%d encoded=%d written=%d nilNals=%d encErr=%d writeBytes=%d fps=%.1f elapsed=%.1fs conn=%s ice=%s",
			sess.sessionID, reason,
			framesReceived, framesDrained, framesEncoded, framesWritten, nilNals, encodeErrors,
			totalWriteBytes, fps, elapsed,
			sess.peer.ConnectionState(), sess.peer.ICEConnectionState())
	}

	for {
		select {
		case <-sess.peer.Done():
			logStats("peer-done")
			return
		case <-activityTimer.C:
			logStats("activity-timeout")
			log.Printf("[session %s] activity timeout (%v with no frames written), closing", sess.sessionID, activityTimeout)
			go sm.StopSession(sess.sessionID)
			return
		case <-statsTicker.C:
			logStats("periodic")
		case fps := <-sess.fpsCh:
			if fps != currentFPS {
				currentFPS = fps
				rateLimiter.Reset(time.Second / time.Duration(currentFPS))
				log.Printf("[session %s] fps_hint: adjusted to %d fps", sess.sessionID, currentFPS)
			}
		case <-rateLimiter.C:
			// Wait for a frame (or drain stale ones).
			var frame *device.Frame
			select {
			case f, ok := <-frames:
				if !ok {
					logStats("frames-closed")
					return
				}
				frame = f
				framesReceived++
			case <-sess.peer.Done():
				logStats("peer-done")
				return
			}

			// Drain any stale frames — always encode the freshest one.
			for {
				select {
				case newer, ok2 := <-frames:
					if !ok2 {
						logStats("frames-closed")
						return
					}
					framesDrained++
					frame = newer
				default:
					goto encode
				}
			}
		encode:

			y, cb, cr := encoder.ScaleAndConvertToI420(
				frame.Data,
				int(frame.Width), int(frame.Height),
				sess.targetW, sess.targetH,
			)

			nals, err := sess.enc.Encode(y, cb, cr)
			encoder.ReleaseI420(y) // return pooled buffer
			if err != nil {
				encodeErrors++
				log.Printf("[session %s] encode error: %v", sess.sessionID, err)
				continue
			}
			if nals == nil {
				nilNals++
				continue
			}
			framesEncoded++

			now := time.Now()
			duration := time.Second / 30
			if !lastTime.IsZero() {
				duration = now.Sub(lastTime)
			}
			lastTime = now

			if err := sess.peer.WriteVideoSample(nals, duration); err != nil {
				logStats("write-error")
				log.Printf("[session %s] write error: %v", sess.sessionID, err)
				return
			}
			framesWritten++
			totalWriteBytes += uint64(len(nals))

			// Reset activity timer on successful write.
			if !activityTimer.Stop() {
				select {
				case <-activityTimer.C:
				default:
				}
			}
			activityTimer.Reset(activityTimeout)
		}
	}
}

func (sm *SessionManager) runNALPipeline(sess *streamSession) {
	id, nals := sess.nalSource.Subscribe()
	defer sess.nalSource.Unsubscribe(id)

	log.Printf("[session %s] NAL pipeline started", sess.sessionID)
	defer log.Printf("[session %s] NAL pipeline stopped", sess.sessionID)

	const activityTimeout = 15 * time.Second
	activityTimer := time.NewTimer(activityTimeout)
	defer activityTimer.Stop()

	var (
		lastPTSUs      int64
		written        uint64
		totalWriteByte uint64
		statsStart     = time.Now()
	)

	for {
		select {
		case <-sess.peer.Done():
			return
		case <-activityTimer.C:
			log.Printf("[session %s] NAL activity timeout (%v with no samples), closing", sess.sessionID, activityTimeout)
			go sm.StopSession(sess.sessionID)
			return
		case unit, ok := <-nals:
			if !ok {
				return
			}

			duration := time.Second / 30
			if lastPTSUs > 0 && unit.PTSUs > lastPTSUs {
				duration = time.Duration(unit.PTSUs-lastPTSUs) * time.Microsecond
				if duration <= 0 || duration > 2*time.Second {
					duration = time.Second / 30
				}
			}
			lastPTSUs = unit.PTSUs

			if err := sess.peer.WriteVideoSample(unit.Data, duration); err != nil {
				log.Printf("[session %s] NAL write error: %v", sess.sessionID, err)
				return
			}
			written++
			totalWriteByte += uint64(len(unit.Data))

			if !activityTimer.Stop() {
				select {
				case <-activityTimer.C:
				default:
				}
			}
			activityTimer.Reset(activityTimeout)

			if written%150 == 0 {
				elapsed := time.Since(statsStart).Seconds()
				fps := float64(0)
				if elapsed > 0 {
					fps = float64(written) / elapsed
				}
				log.Printf("[session %s] NAL stats: written=%d bytes=%d fps=%.1f elapsed=%.1fs",
					sess.sessionID, written, totalWriteByte, fps, elapsed)
			}
		}
	}
}

func estimateAndroidBitrate(width, height, fps int) int {
	pixels := width * height
	switch {
	case pixels <= 640*360:
		return 800_000
	case pixels <= 960*540:
		return 1_200_000
	case pixels <= 1280*720:
		return 2_000_000
	default:
		if fps > 45 {
			return 4_000_000
		}
		return 3_000_000
	}
}

// sendOffer sends a WebRTC offer to the Yep server.
func (sm *SessionManager) sendOffer(sessionID, sdp string) {
	msg, _ := json.Marshal(map[string]string{
		"type":      "webrtc.offer",
		"sessionId": sessionID,
		"sdp":       sdp,
	})
	sm.sendMsg(msg)
}

// sendICE sends an ICE candidate to the Yep server.
func (sm *SessionManager) sendICE(sessionID string, candidate *stream.ICECandidateJSON) {
	m := map[string]interface{}{
		"type":      "webrtc.ice",
		"sessionId": sessionID,
	}
	if candidate == nil {
		m["candidate"] = nil
	} else {
		m["candidate"] = candidate
	}
	msg, _ := json.Marshal(m)
	sm.sendMsg(msg)
}

// sendState sends a session state change to the Yep server.
func (sm *SessionManager) sendState(sessionID, state, errMsg string) {
	m := map[string]string{
		"type":      "session.state",
		"sessionId": sessionID,
		"state":     state,
	}
	if errMsg != "" {
		m["error"] = errMsg
	}
	msg, _ := json.Marshal(m)
	sm.sendMsg(msg)
}
