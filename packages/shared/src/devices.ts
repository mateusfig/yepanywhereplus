/**
 * Shared types for the device bridge streaming feature.
 *
 * These types are used by:
 * - Server: DeviceBridgeService, REST routes, relay message routing
 * - Client: device tab UI, WebRTC signaling (Phase 3)
 */

/** Canonical device classes supported by the bridge. */
export type DeviceType = "emulator" | "android" | "chromeos" | "ios-simulator";

/** Canonical device states surfaced to the client. */
export type DeviceState =
  | "running"
  | "stopped"
  | "connected"
  | "disconnected"
  | "booted";

/** High-level actions currently supported by a device entry. */
export type DeviceAction = "stream" | "screenshot" | "start" | "stop";

// ============================================================================
// Device Discovery
// ============================================================================

/** Canonical info about a discovered bridge device. */
export interface DeviceInfo {
  /** Stable device identifier used for start/stop/stream operations. */
  id: string;
  /** Human-friendly name for display in the UI. */
  label: string;
  /** Device class used for routing and UI grouping. */
  type: DeviceType;
  /** Current runtime status. */
  state: DeviceState;
  /** Supported actions for this specific device instance/state. */
  actions?: DeviceAction[];
  /**
   * Legacy field kept for compatibility with older clients.
   * Prefer `label` for all new UI.
   */
  avd?: string;
}

// ============================================================================
// Client → Server: device signaling messages (carried via relay WebSocket)
// ============================================================================

/** Client requests to start streaming an emulator. */
export interface DeviceStreamStart {
  type: "device_stream_start";
  /** Client-generated UUID for this streaming session */
  sessionId: string;
  /** Which device to stream (DeviceInfo.id) */
  deviceId: string;
  /**
   * Optional explicit device type. Used to avoid server-side ID heuristics
   * when deciding transport/runtime dependencies.
   */
  deviceType?: DeviceType;
  /** Optional streaming parameters */
  options?: { maxFps?: number; maxWidth?: number; quality?: number };
}

/** Client requests to stop streaming. */
export interface DeviceStreamStop {
  type: "device_stream_stop";
  /** Streaming session ID from device_stream_start */
  sessionId: string;
}

/** Client sends SDP answer for WebRTC negotiation. */
export interface DeviceWebRTCAnswer {
  type: "device_webrtc_answer";
  sessionId: string;
  sdp: string;
}

/** Client sends an ICE candidate (trickle ICE). */
export interface DeviceICECandidate {
  type: "device_ice_candidate";
  sessionId: string;
  /** null = end-of-candidates signal */
  candidate: RTCIceCandidateInit | null;
}

/** Union of all client→server device messages */
export type DeviceClientMessage =
  | DeviceStreamStart
  | DeviceStreamStop
  | DeviceWebRTCAnswer
  | DeviceICECandidate;

// ============================================================================
// Server → Client: device signaling messages (pushed via relay WebSocket)
// ============================================================================

/** Server sends SDP offer for WebRTC negotiation. */
export interface DeviceWebRTCOffer {
  type: "device_webrtc_offer";
  sessionId: string;
  sdp: string;
}

/** Server sends an ICE candidate (trickle ICE). */
export interface DeviceICECandidateEvent {
  type: "device_ice_candidate_event";
  sessionId: string;
  /** null = end-of-candidates signal */
  candidate: RTCIceCandidateInit | null;
}

/** Server sends streaming session state change. */
export interface DeviceSessionState {
  type: "device_session_state";
  sessionId: string;
  state: "connecting" | "connected" | "disconnected" | "failed";
  error?: string;
}

/** Union of all server→client device messages */
export type DeviceServerMessage =
  | DeviceWebRTCOffer
  | DeviceICECandidateEvent
  | DeviceSessionState;

// ============================================================================
// RTCIceCandidateInit shim (for environments without WebRTC globals)
// ============================================================================

/**
 * Minimal RTCIceCandidateInit for server-side use.
 * This avoids depending on DOM types in Node.
 */
export interface RTCIceCandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}
