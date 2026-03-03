package conn

import (
	"encoding/binary"
	"fmt"
	"io"
)

const (
	TypeFrameRequest  byte = 0x01
	TypeFrameResponse byte = 0x02
	TypeControl       byte = 0x03
	TypeStreamStatus  byte = 0x04
	TypeStreamNAL     byte = 0x05
)

// WriteFrameRequest writes a single-byte frame request message.
func WriteFrameRequest(w io.Writer) error {
	_, err := w.Write([]byte{TypeFrameRequest})
	return err
}

// WriteFrameResponse writes a length-prefixed frame payload.
func WriteFrameResponse(w io.Writer, frame []byte) error {
	return writeLengthPrefixed(w, TypeFrameResponse, frame)
}

// WriteControl writes a length-prefixed control payload.
func WriteControl(w io.Writer, payload []byte) error {
	return writeLengthPrefixed(w, TypeControl, payload)
}

// WriteStreamStatus writes a length-prefixed stream status payload.
func WriteStreamStatus(w io.Writer, payload []byte) error {
	return writeLengthPrefixed(w, TypeStreamStatus, payload)
}

// StreamNAL is one push-based H.264 access unit from the on-device encoder.
type StreamNAL struct {
	Flags byte
	PTSUs uint64
	Data  []byte
}

// WriteStreamNAL writes a stream NAL packet with flags and presentation timestamp.
func WriteStreamNAL(w io.Writer, flags byte, ptsUs uint64, data []byte) error {
	var header [14]byte
	header[0] = TypeStreamNAL
	header[1] = flags
	binary.LittleEndian.PutUint64(header[2:], ptsUs)
	binary.LittleEndian.PutUint32(header[10:], uint32(len(data)))

	if _, err := w.Write(header[:]); err != nil {
		return err
	}
	if len(data) == 0 {
		return nil
	}
	_, err := w.Write(data)
	return err
}

// ReadMessage reads one protocol message from r.
func ReadMessage(r io.Reader) (msgType byte, payload []byte, err error) {
	var typeBuf [1]byte
	if _, err := io.ReadFull(r, typeBuf[:]); err != nil {
		return 0, nil, err
	}

	switch typeBuf[0] {
	case TypeFrameRequest:
		return TypeFrameRequest, nil, nil

	case TypeFrameResponse, TypeControl, TypeStreamStatus:
		var lenBuf [4]byte
		if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
			return 0, nil, err
		}

		payloadLen := binary.LittleEndian.Uint32(lenBuf[:])
		payload := make([]byte, payloadLen)
		if _, err := io.ReadFull(r, payload); err != nil {
			return 0, nil, err
		}
		return typeBuf[0], payload, nil

	default:
		return 0, nil, fmt.Errorf("unknown message type: 0x%02x", typeBuf[0])
	}
}

// ReadStreamNALBody reads the body of a TypeStreamNAL packet (after the 0x05 type byte).
func ReadStreamNALBody(r io.Reader) (*StreamNAL, error) {
	var header [13]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}

	ptsUs := binary.LittleEndian.Uint64(header[1:9])
	payloadLen := binary.LittleEndian.Uint32(header[9:])
	payload := make([]byte, payloadLen)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, err
	}

	return &StreamNAL{
		Flags: header[0],
		PTSUs: ptsUs,
		Data:  payload,
	}, nil
}

func writeLengthPrefixed(w io.Writer, msgType byte, payload []byte) error {
	var header [5]byte
	header[0] = msgType
	binary.LittleEndian.PutUint32(header[1:], uint32(len(payload)))

	if _, err := w.Write(header[:]); err != nil {
		return err
	}

	if len(payload) == 0 {
		return nil
	}

	_, err := w.Write(payload)
	return err
}
