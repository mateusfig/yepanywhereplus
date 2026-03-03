package device

import "sync"

// NalUnit is one encoded H.264 access unit from device hardware encoder.
type NalUnit struct {
	Data     []byte
	Keyframe bool
	Config   bool
	PTSUs    int64
}

// NalSource fans out push-based NAL units to subscribers.
type NalSource struct {
	mu     sync.RWMutex
	subs   map[int]chan *NalUnit
	nextID int
	closed bool
}

func NewNalSource() *NalSource {
	return &NalSource{
		subs: make(map[int]chan *NalUnit),
	}
}

func (ns *NalSource) Subscribe() (id int, ch <-chan *NalUnit) {
	ns.mu.Lock()
	defer ns.mu.Unlock()

	id = ns.nextID
	ns.nextID++
	c := make(chan *NalUnit, 128)
	if ns.closed {
		close(c)
		return id, c
	}
	ns.subs[id] = c
	return id, c
}

func (ns *NalSource) Unsubscribe(id int) {
	ns.mu.Lock()
	defer ns.mu.Unlock()
	if ch, ok := ns.subs[id]; ok {
		close(ch)
		delete(ns.subs, id)
	}
}

func (ns *NalSource) Publish(unit *NalUnit) {
	ns.mu.RLock()
	defer ns.mu.RUnlock()
	if ns.closed {
		return
	}
	for _, ch := range ns.subs {
		select {
		case ch <- unit:
		default:
			// Drop one stale packet to avoid deadlock on slow consumers.
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- unit:
			default:
			}
		}
	}
}

func (ns *NalSource) Stop() {
	ns.mu.Lock()
	defer ns.mu.Unlock()
	if ns.closed {
		return
	}
	ns.closed = true
	for id, ch := range ns.subs {
		close(ch)
		delete(ns.subs, id)
	}
}
