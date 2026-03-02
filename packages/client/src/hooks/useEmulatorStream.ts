import type { DeviceServerMessage, DeviceType } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getGlobalConnection } from "../lib/connection";
import { getWebSocketConnection } from "../lib/connection/WebSocketConnection";
import { generateUUID } from "../lib/uuid";
import { QUALITY_TO_CRF, getEmulatorSettings } from "./useEmulatorSettings";

const LOG_PREFIX = "[EmulatorStream]";

export type EmulatorConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed";

interface UseEmulatorStreamResult {
  /** Ref to attach to a <video> element */
  remoteStream: MediaStream | null;
  /** WebRTC DataChannel for touch/key input */
  dataChannel: RTCDataChannel | null;
  /** RTCPeerConnection for diagnostics (getStats) */
  peerConnection: RTCPeerConnection | null;
  /** Current connection state */
  connectionState: EmulatorConnectionState;
  /** Error message if connection failed */
  error: string | null;
  /** Start streaming from the specified device */
  connect: (device: { id: string; type?: DeviceType }) => void;
  /** Stop streaming */
  disconnect: () => void;
}

/**
 * Hook that manages WebRTC peer connection and signaling for emulator streaming.
 *
 * Signaling flow:
 * 1. Client sends device_stream_start via relay
 * 2. Server/sidecar responds with device_webrtc_offer (SDP)
 * 3. Client creates RTCPeerConnection, sets remote description, creates answer
 * 4. Client sends device_webrtc_answer
 * 5. ICE candidates exchanged bidirectionally
 * 6. WebRTC P2P established (video + data channel)
 */
export function useEmulatorStream(): UseEmulatorStreamResult {
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const [connectionState, setConnectionState] =
    useState<EmulatorConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const getConnection = useCallback(() => {
    // Remote mode: use global SecureConnection
    const global = getGlobalConnection();
    if (global) return global;
    // Local mode: use WebSocket connection
    return getWebSocketConnection();
  }, []);

  const disconnect = useCallback(() => {
    const sid = sessionIdRef.current;
    console.log(`${LOG_PREFIX} disconnect() called, session=${sid}`);

    // Send stop message
    if (sid) {
      try {
        const conn = getConnection();
        conn.sendMessage?.({
          type: "device_stream_stop",
          sessionId: sid,
        });
      } catch {
        // Connection may already be closed
      }
    }

    // Close peer connection
    if (pcRef.current) {
      const pc = pcRef.current;
      console.log(
        `${LOG_PREFIX} closing RTCPeerConnection (state=${pc.connectionState}, ice=${pc.iceConnectionState})`,
      );
      pc.close();
      pcRef.current = null;
    }

    // Unsubscribe from emulator messages
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }

    sessionIdRef.current = null;
    setRemoteStream(null);
    setDataChannel(null);
    setConnectionState("idle");
    setError(null);
  }, [getConnection]);

  const connect = useCallback(
    (device: { id: string; type?: DeviceType }) => {
      // Clean up any existing connection
      disconnect();

      const sessionId = generateUUID();
      sessionIdRef.current = sessionId;
      const sid = sessionId.slice(0, 8);
      console.log(
        `${LOG_PREFIX} connect(deviceId=${device.id}, type=${device.type ?? "unknown"}, session=${sid})`,
      );
      setConnectionState("connecting");
      setError(null);

      const conn = getConnection();

      // Create RTCPeerConnection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;

      // Handle remote stream
      pc.ontrack = (event) => {
        const track = event.track;
        console.log(
          `${LOG_PREFIX} [${sid}] ontrack: kind=${track.kind} id=${track.id} readyState=${track.readyState} muted=${track.muted}`,
        );
        if (event.streams[0]) {
          setRemoteStream(event.streams[0]);
        }
        // Monitor track lifecycle
        track.onmute = () =>
          console.warn(`${LOG_PREFIX} [${sid}] track MUTED: ${track.id}`);
        track.onunmute = () =>
          console.log(`${LOG_PREFIX} [${sid}] track unmuted: ${track.id}`);
        track.onended = () =>
          console.warn(`${LOG_PREFIX} [${sid}] track ENDED: ${track.id}`);
      };

      // Handle data channel from sidecar
      pc.ondatachannel = (event) => {
        const dc = event.channel;
        console.log(
          `${LOG_PREFIX} [${sid}] ondatachannel: label=${dc.label} id=${dc.id}`,
        );
        dc.onopen = () => {
          console.log(
            `${LOG_PREFIX} [${sid}] DataChannel "${dc.label}" opened`,
          );
          setDataChannel(dc);
        };
        dc.onclose = () => {
          console.warn(
            `${LOG_PREFIX} [${sid}] DataChannel "${dc.label}" closed`,
          );
          setDataChannel(null);
        };
        dc.onerror = (ev) => {
          console.error(
            `${LOG_PREFIX} [${sid}] DataChannel "${dc.label}" error:`,
            ev,
          );
        };
      };

      // Connection state tracking
      pc.onconnectionstatechange = () => {
        console.log(
          `${LOG_PREFIX} [${sid}] connectionState: ${pc.connectionState}`,
        );
        switch (pc.connectionState) {
          case "connected":
            setConnectionState("connected");
            break;
          case "disconnected":
            setConnectionState("disconnected");
            break;
          case "failed":
            setConnectionState("failed");
            setError("WebRTC connection failed");
            break;
          case "closed":
            setConnectionState("disconnected");
            break;
        }
      };

      // ICE connection state (more granular than connectionState)
      pc.oniceconnectionstatechange = () => {
        console.log(
          `${LOG_PREFIX} [${sid}] iceConnectionState: ${pc.iceConnectionState}`,
        );
      };

      // ICE gathering state
      pc.onicegatheringstatechange = () => {
        console.log(
          `${LOG_PREFIX} [${sid}] iceGatheringState: ${pc.iceGatheringState}`,
        );
      };

      // Signaling state
      pc.onsignalingstatechange = () => {
        console.log(
          `${LOG_PREFIX} [${sid}] signalingState: ${pc.signalingState}`,
        );
      };

      // Send ICE candidates to sidecar via relay
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log(
            `${LOG_PREFIX} [${sid}] sending ICE candidate: ${event.candidate.candidate.slice(0, 60)}...`,
          );
        } else {
          console.log(
            `${LOG_PREFIX} [${sid}] ICE gathering complete (null candidate)`,
          );
        }
        conn.sendMessage?.({
          type: "device_ice_candidate",
          sessionId,
          candidate: event.candidate
            ? {
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
                usernameFragment: event.candidate.usernameFragment,
              }
            : null,
        });
      };

      // Listen for signaling messages from server
      const unsub = conn.onDeviceMessage?.(async (msg: DeviceServerMessage) => {
        if (msg.sessionId !== sessionId) return;

        switch (msg.type) {
          case "device_webrtc_offer": {
            console.log(
              `${LOG_PREFIX} [${sid}] received SDP offer (${msg.sdp.length} bytes)`,
            );
            try {
              await pc.setRemoteDescription({
                type: "offer",
                sdp: msg.sdp,
              });
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              console.log(
                `${LOG_PREFIX} [${sid}] sent SDP answer (${(answer.sdp ?? "").length} bytes)`,
              );
              conn.sendMessage?.({
                type: "device_webrtc_answer",
                sessionId,
                sdp: answer.sdp ?? "",
              });
            } catch (err) {
              console.error(
                `${LOG_PREFIX} [${sid}] SDP negotiation failed:`,
                err,
              );
              setConnectionState("failed");
              setError(
                `WebRTC negotiation failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            break;
          }

          case "device_ice_candidate_event": {
            if (msg.candidate) {
              console.log(
                `${LOG_PREFIX} [${sid}] received remote ICE candidate`,
              );
              try {
                await pc.addIceCandidate(msg.candidate);
              } catch (err) {
                console.warn(
                  `${LOG_PREFIX} [${sid}] failed to add ICE candidate:`,
                  err,
                );
              }
            } else {
              console.log(
                `${LOG_PREFIX} [${sid}] remote ICE gathering complete`,
              );
            }
            break;
          }

          case "device_session_state": {
            console.log(
              `${LOG_PREFIX} [${sid}] server session state: ${msg.state}${msg.error ? ` error=${msg.error}` : ""}`,
            );
            if (msg.state === "failed" || msg.state === "disconnected") {
              setConnectionState(msg.state);
              if (msg.error) setError(msg.error);
            }
            break;
          }
        }
      });
      unsubRef.current = unsub ?? null;

      // Ensure WebSocket is connected before sending start message
      const ensureConnected = (
        conn as { ensureConnected?: () => Promise<void> }
      ).ensureConnected?.bind(conn);
      const sendStart = () => {
        const { maxFps, maxWidth, quality } = getEmulatorSettings();
        const crf = QUALITY_TO_CRF[quality];
        console.log(
          `${LOG_PREFIX} [${sid}] sending device_stream_start fps=${maxFps} width=${maxWidth} quality=${quality}(crf=${crf})`,
        );
        conn.sendMessage?.({
          type: "device_stream_start",
          sessionId,
          deviceId: device.id,
          deviceType: device.type,
          options: { maxFps, maxWidth, quality: crf },
        });
      };
      if (ensureConnected) {
        ensureConnected()
          .then(sendStart)
          .catch((err: unknown) => {
            console.error(
              `${LOG_PREFIX} [${sid}] ensureConnected failed:`,
              err,
            );
            setConnectionState("failed");
            setError(
              `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      } else {
        sendStart();
      }
    },
    [disconnect, getConnection],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
      // Send stop if we have a session
      if (sessionIdRef.current) {
        try {
          const global = getGlobalConnection();
          const conn = global ?? getWebSocketConnection();
          conn.sendMessage?.({
            type: "device_stream_stop",
            sessionId: sessionIdRef.current,
          });
        } catch {
          // Best-effort
        }
      }
    };
  }, []);

  return {
    remoteStream,
    dataChannel,
    peerConnection: pcRef.current,
    connectionState,
    error,
    connect,
    disconnect,
  };
}
