package encoder

import (
	"bytes"
	"fmt"
	"image"

	x264 "github.com/gen2brain/x264-go"
)

// H264Encoder wraps x264 for per-frame h264 encoding.
type H264Encoder struct {
	encoder *x264.Encoder
	buf     *bytes.Buffer
	width   int
	height  int
}

// NewH264Encoder creates and configures the x264 encoder.
func NewH264Encoder(width, height, fps int) (*H264Encoder, error) {
	buf := &bytes.Buffer{}

	opts := &x264.Options{
		Width:        width,
		Height:       height,
		FrameRate:    fps,
		Preset:       "ultrafast",
		Tune:         "zerolatency",
		Profile:      "baseline",
		RateControl:  "crf",
		RateConstant: 30, // ~2-5 Mbps at 720p; without this, ultrafast produces ~30 Mbps
		LogLevel:     x264.LogWarning,
	}

	enc, err := x264.NewEncoder(buf, opts)
	if err != nil {
		return nil, fmt.Errorf("creating x264 encoder: %w", err)
	}

	e := &H264Encoder{
		encoder: enc,
		buf:     buf,
		width:   width,
		height:  height,
	}

	return e, nil
}

// Encode encodes a single I420 frame and returns the Annex B NAL bytes.
// The y, cb, cr slices must have the correct sizes for the encoder dimensions.
func (e *H264Encoder) Encode(y, cb, cr []byte) ([]byte, error) {
	// Construct x264.YCbCr (wraps image.YCbCr) for the fast path in x264-go.
	ycbcr := &x264.YCbCr{
		YCbCr: &image.YCbCr{
			Y:              y,
			Cb:             cb,
			Cr:             cr,
			YStride:        e.width,
			CStride:        e.width / 2,
			SubsampleRatio: image.YCbCrSubsampleRatio420,
			Rect:           image.Rect(0, 0, e.width, e.height),
		},
	}

	// Reset buffer to capture only this frame's NALs.
	e.buf.Reset()

	if err := e.encoder.Encode(ycbcr); err != nil {
		return nil, fmt.Errorf("encoding frame: %w", err)
	}

	if e.buf.Len() == 0 {
		return nil, nil
	}

	// Copy the bytes so the buffer can be reused.
	out := make([]byte, e.buf.Len())
	copy(out, e.buf.Bytes())
	return out, nil
}

// Close releases encoder resources.
func (e *H264Encoder) Close() {
	e.encoder.Flush()
	e.encoder.Close()
}
