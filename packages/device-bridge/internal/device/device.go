package device

import "context"

// TouchPoint represents a normalized touch input event.
type TouchPoint struct {
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	Pressure   float64 `json:"pressure"`
	Identifier int32   `json:"id,omitempty"`
}

// Frame contains one RGB888 frame from a device.
type Frame struct {
	Data      []byte
	Width     int32
	Height    int32
	Seq       uint32
	Timestamp uint64
}

// Device is the common interface for emulator, Android USB, and ChromeOS targets.
type Device interface {
	GetFrame(ctx context.Context, maxWidth int) (*Frame, error)
	SendTouch(ctx context.Context, touches []TouchPoint) error
	SendKey(ctx context.Context, key string) error
	ScreenSize() (width, height int32)
	Close() error
}

// StreamOptions configures on-device hardware streaming.
type StreamOptions struct {
	Width      int
	Height     int
	FPS        int
	BitrateBps int
}

// StreamCapable is implemented by devices that can push H.264 directly.
type StreamCapable interface {
	StartStream(ctx context.Context, opts StreamOptions) (*NalSource, error)
	StopStream(ctx context.Context) error
	SetStreamBitrate(ctx context.Context, bps int) error
	RequestStreamKeyframe(ctx context.Context) error
}
