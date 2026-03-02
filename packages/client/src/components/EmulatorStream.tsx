import { useCallback, useEffect, useRef } from "react";

interface EmulatorStreamProps {
  /** Remote MediaStream from WebRTC */
  stream: MediaStream | null;
  /** WebRTC DataChannel for sending touch/key events */
  dataChannel: RTCDataChannel | null;
  /** RTCPeerConnection for diagnostics */
  peerConnection: RTCPeerConnection | null;
}

/**
 * Compute the actual rendered video rect within the element,
 * accounting for `object-fit: contain` letterboxing.
 */
function getVideoRect(video: HTMLVideoElement): DOMRect {
  const elem = video.getBoundingClientRect();
  const videoW = video.videoWidth;
  const videoH = video.videoHeight;

  // Before video metadata loads, fall back to element rect
  if (!videoW || !videoH) return elem;

  const scale = Math.min(elem.width / videoW, elem.height / videoH);
  const renderW = videoW * scale;
  const renderH = videoH * scale;

  return new DOMRect(
    elem.left + (elem.width - renderW) / 2,
    elem.top + (elem.height - renderH) / 2,
    renderW,
    renderH,
  );
}

/** Clamp a value to [0, 1]. */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Video element for emulator stream with touch and mouse event capture.
 * Coordinates are normalized to 0.0-1.0, accounting for object-fit letterboxing.
 */
export function EmulatorStream({ stream, dataChannel, peerConnection }: EmulatorStreamProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Attach stream to video element and monitor health
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;

    if (!stream) return;

    const tracks = stream.getVideoTracks();
    console.log(
      `[EmulatorStream] attached stream: ${tracks.length} video track(s), active=${stream.active}`,
    );
    for (const t of tracks) {
      console.log(
        `[EmulatorStream] track ${t.id}: readyState=${t.readyState} enabled=${t.enabled} muted=${t.muted}`,
      );
    }

    // Monitor video playback health — detect stale frames
    let lastTime = -1;
    let staleCount = 0;
    let lastPacketsReceived = 0;
    let lastBytesReceived = 0;
    const healthCheck = setInterval(async () => {
      const ct = video.currentTime;
      if (lastTime >= 0 && ct === lastTime && !video.paused) {
        staleCount++;

        // Query WebRTC stats to see if RTP packets are still arriving
        let statsInfo = "";
        if (peerConnection && peerConnection.connectionState !== "closed") {
          try {
            const stats = await peerConnection.getStats();
            stats.forEach((report) => {
              if (report.type === "inbound-rtp" && report.kind === "video") {
                const pkts = report.packetsReceived ?? 0;
                const bytes = report.bytesReceived ?? 0;
                const lost = report.packetsLost ?? 0;
                const pktsDelta = pkts - lastPacketsReceived;
                const bytesDelta = bytes - lastBytesReceived;
                lastPacketsReceived = pkts;
                lastBytesReceived = bytes;
                statsInfo = ` rtp: +${pktsDelta}pkts/+${bytesDelta}bytes (total=${pkts}, lost=${lost})`;
              }
            });
          } catch { /* pc may be closing */ }
        }

        if (staleCount === 1) {
          console.warn(
            `[EmulatorStream] video stale: currentTime=${ct.toFixed(3)} not advancing${statsInfo}`,
          );
        } else if (staleCount % 6 === 0) {
          // Log every 30s (6 × 5s intervals)
          const track = stream.getVideoTracks()[0];
          console.warn(
            `[EmulatorStream] video still stale (${staleCount * 5}s): currentTime=${ct.toFixed(3)}, track=${track?.readyState ?? "none"}, streamActive=${stream.active}${statsInfo}`,
          );
        } else {
          console.warn(
            `[EmulatorStream] video stale (${staleCount * 5}s)${statsInfo}`,
          );
        }
      } else {
        if (staleCount > 0) {
          console.log(
            `[EmulatorStream] video resumed after ${staleCount * 5}s stale`,
          );
        }
        staleCount = 0;
        // Track baseline RTP stats when healthy
        if (peerConnection && peerConnection.connectionState !== "closed") {
          try {
            const stats = await peerConnection.getStats();
            stats.forEach((report) => {
              if (report.type === "inbound-rtp" && report.kind === "video") {
                lastPacketsReceived = report.packetsReceived ?? 0;
                lastBytesReceived = report.bytesReceived ?? 0;
              }
            });
          } catch { /* ignore */ }
        }
      }
      lastTime = ct;
    }, 5000);

    // Monitor stream-level events
    const onRemoveTrack = (e: MediaStreamTrackEvent) => {
      console.warn(
        `[EmulatorStream] stream removetrack: ${e.track.kind} ${e.track.id}`,
      );
    };
    const onInactive = () => {
      console.warn("[EmulatorStream] stream became inactive");
    };
    stream.addEventListener("removetrack", onRemoveTrack);
    stream.addEventListener("inactive", onInactive);

    return () => {
      clearInterval(healthCheck);
      stream.removeEventListener("removetrack", onRemoveTrack);
      stream.removeEventListener("inactive", onInactive);
    };
  }, [stream]);

  const canSend = useCallback(() => {
    return dataChannel && dataChannel.readyState === "open";
  }, [dataChannel]);

  const sendTouches = useCallback(
    (
      touches: Array<{
        clientX: number;
        clientY: number;
        id: number;
        pressure: number;
      }>,
      video: HTMLVideoElement,
    ) => {
      if (!canSend() || !dataChannel) return;
      const rect = getVideoRect(video);
      const mapped = touches.map((t) => ({
        x: clamp01((t.clientX - rect.left) / rect.width),
        y: clamp01((t.clientY - rect.top) / rect.height),
        pressure: t.pressure,
        id: t.id,
      }));
      dataChannel.send(JSON.stringify({ type: "touch", touches: mapped }));
    },
    [canSend, dataChannel],
  );

  // --- Touch handlers (native, non-passive to allow preventDefault) ---

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      sendTouches(
        Array.from(e.touches).map((t) => ({
          clientX: t.clientX,
          clientY: t.clientY,
          id: t.identifier,
          pressure: t.force || 0.5,
        })),
        video,
      );
    };

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      sendTouches(
        Array.from(e.touches).map((t) => ({
          clientX: t.clientX,
          clientY: t.clientY,
          id: t.identifier,
          pressure: t.force || 0.5,
        })),
        video,
      );
    };

    const handleTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      // On touchend, event.touches is empty — use changedTouches with pressure 0 (release)
      sendTouches(
        Array.from(e.changedTouches).map((t) => ({
          clientX: t.clientX,
          clientY: t.clientY,
          id: t.identifier,
          pressure: 0,
        })),
        video,
      );
    };

    const opts = { passive: false } as const;
    video.addEventListener("touchstart", handleTouchStart, opts);
    video.addEventListener("touchmove", handleTouchMove, opts);
    video.addEventListener("touchend", handleTouchEnd, opts);
    video.addEventListener("touchcancel", handleTouchEnd, opts);

    return () => {
      video.removeEventListener("touchstart", handleTouchStart);
      video.removeEventListener("touchmove", handleTouchMove);
      video.removeEventListener("touchend", handleTouchEnd);
      video.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [sendTouches]);

  // --- Mouse handlers (desktop fallback) ---

  const mouseDown = useRef(false);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLVideoElement>) => {
      e.preventDefault();
      mouseDown.current = true;
      sendTouches(
        [{ clientX: e.clientX, clientY: e.clientY, id: 0, pressure: 0.5 }],
        e.currentTarget,
      );
    },
    [sendTouches],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLVideoElement>) => {
      if (!mouseDown.current) return;
      e.preventDefault();
      sendTouches(
        [{ clientX: e.clientX, clientY: e.clientY, id: 0, pressure: 0.5 }],
        e.currentTarget,
      );
    },
    [sendTouches],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLVideoElement>) => {
      if (!mouseDown.current) return;
      mouseDown.current = false;
      e.preventDefault();
      sendTouches(
        [{ clientX: e.clientX, clientY: e.clientY, id: 0, pressure: 0 }],
        e.currentTarget,
      );
    },
    [sendTouches],
  );

  // Reset mouse state if pointer leaves the element
  const handleMouseLeave = useCallback(
    (e: React.MouseEvent<HTMLVideoElement>) => {
      if (!mouseDown.current) return;
      mouseDown.current = false;
      sendTouches(
        [{ clientX: e.clientX, clientY: e.clientY, id: 0, pressure: 0 }],
        e.currentTarget,
      );
    },
    [sendTouches],
  );

  return (
    <video
      ref={videoRef}
      className="emulator-video"
      autoPlay
      playsInline
      muted
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
    />
  );
}
