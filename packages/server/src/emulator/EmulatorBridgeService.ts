import { type ChildProcess, execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type {
  EmulatorICECandidate,
  EmulatorICECandidateEvent,
  EmulatorInfo,
  EmulatorSessionState,
  EmulatorStreamStart,
  EmulatorStreamStop,
  EmulatorWebRTCAnswer,
  EmulatorWebRTCOffer,
  RTCIceCandidateInit,
} from "@yep-anywhere/shared";
import { WebSocket } from "ws";

/** Sidecar stdout handshake message */
interface SidecarHandshake {
  port: number;
  version: string;
}

/** IPC message from sidecar → server */
interface SidecarMessage {
  type: string;
  sessionId?: string;
  emulatorId?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit | null;
  state?: string;
  error?: string;
}

/** Callback for forwarding sidecar messages to a specific client */
type ClientSendFn = (
  msg: EmulatorWebRTCOffer | EmulatorICECandidateEvent | EmulatorSessionState,
) => void;

export interface EmulatorBridgeServiceOptions {
  /** Path to adb binary */
  adbPath: string;
  /** Data directory for locating the sidecar binary */
  dataDir: string;
}

/**
 * Manages the emulator-bridge sidecar lifecycle and proxies
 * WebRTC signaling between clients and the sidecar.
 */
export class EmulatorBridgeService {
  private adbPath: string;
  private dataDir: string;
  private process: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private port: number | null = null;
  private available = false;
  private starting = false;
  private startPromise: Promise<void> | null = null;
  private restartAttempts = 0;
  private maxRestartAttempts = 5;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  /** Maps streaming sessionId → client send function */
  private clientSenders = new Map<string, ClientSendFn>();

  constructor(options: EmulatorBridgeServiceOptions) {
    this.adbPath = options.adbPath;
    this.dataDir = options.dataDir;
  }

  /** Whether the bridge is available (sidecar running and connected). */
  isAvailable(): boolean {
    return this.available;
  }

  /** Find the sidecar binary path. */
  private findBinaryPath(): string | null {
    // Dev mode: local build
    const devPath = path.resolve(
      import.meta.dirname,
      "../../../emulator-bridge/bridge",
    );
    if (fs.existsSync(devPath)) {
      return devPath;
    }

    // Production: downloaded binary
    const platform = os.platform() === "darwin" ? "darwin" : "linux";
    const arch = os.arch() === "arm64" ? "arm64" : "amd64";
    const prodPath = path.join(
      this.dataDir,
      "bin",
      `emulator-bridge-${platform}-${arch}`,
    );
    if (fs.existsSync(prodPath)) {
      return prodPath;
    }

    return null;
  }

  /** Whether the sidecar binary is available (without starting it). */
  hasBinary(): boolean {
    return this.findBinaryPath() !== null;
  }

  /** Ensure the sidecar is running. Lazy start on first use. */
  async ensureStarted(): Promise<void> {
    if (this.available) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /** Kill any stale bridge processes from previous server runs. */
  private killStaleProcesses(): void {
    const binaryPath = this.findBinaryPath();
    if (!binaryPath) return;

    const currentPid = this.process?.pid;

    try {
      // Find all processes matching the bridge binary path
      const result = execSync(`pgrep -f "${binaryPath}" 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 3000,
      }).trim();

      if (result) {
        const pids = result
          .split("\n")
          .filter(Boolean)
          .map(Number)
          .filter((pid) => pid !== currentPid);
        for (const pid of pids) {
          try {
            process.kill(pid, "SIGTERM");
            console.log(`[EmulatorBridge] Killed stale bridge process ${pid}`);
          } catch {
            // Process might have already exited.
          }
        }
      }
    } catch {
      // pgrep returns non-zero if no matches — expected.
    }
  }

  /** Start the sidecar process and establish IPC. */
  private async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;

    // Cancel any pending restart timer to prevent cascading restarts.
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    try {
      const binaryPath = this.findBinaryPath();
      if (!binaryPath) {
        throw new Error(
          "Emulator bridge binary not found. Build it or download it first.",
        );
      }

      // Kill any orphaned bridge processes from previous server runs.
      this.killStaleProcesses();

      console.log(`[EmulatorBridge] Starting sidecar: ${binaryPath}`);

      const child = spawn(binaryPath, ["--ipc", "--adb-path", this.adbPath], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.process = child;

      // Read the handshake from stdout (first line).
      const handshake = await this.readHandshake(child);
      this.port = handshake.port;

      console.log(
        `[EmulatorBridge] Sidecar started on port ${this.port} (v${handshake.version})`,
      );

      // Pipe stderr to our console.
      child.stderr?.on("data", (data: Buffer) => {
        const lines = data.toString().trim().split("\n");
        for (const line of lines) {
          console.log(`[EmulatorBridge/sidecar] ${line}`);
        }
      });

      // Monitor exit — ignore stale events from previously-killed processes.
      child.on("exit", (code, signal) => {
        if (this.process !== child) return;
        console.warn(
          `[EmulatorBridge] Sidecar exited (code=${code}, signal=${signal})`,
        );
        this.cleanup();
        // Don't auto-restart on clean exit (idle shutdown, code=0)
        // or intentional kill (code=null, signal=SIGTERM).
        if (code != null && code !== 0) {
          this.scheduleRestart();
        }
      });

      // Connect WebSocket.
      await this.connectWebSocket();

      this.available = true;
      this.restartAttempts = 0;
    } finally {
      this.starting = false;
    }
  }

  /** Read the JSON handshake from the sidecar's stdout. */
  private readHandshake(child: ChildProcess): Promise<SidecarHandshake> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Sidecar handshake timed out (5s)"));
      }, 5000);

      if (!child.stdout) {
        reject(new Error("Sidecar process has no stdout"));
        return;
      }
      const rl = createInterface({ input: child.stdout });
      rl.once("line", (line) => {
        clearTimeout(timeout);
        rl.close();
        try {
          const data = JSON.parse(line) as SidecarHandshake;
          if (!data.port) {
            reject(new Error(`Invalid handshake: ${line}`));
          } else {
            resolve(data);
          }
        } catch {
          reject(new Error(`Failed to parse handshake: ${line}`));
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      child.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Sidecar exited during handshake (code=${code})`));
      });
    });
  }

  /** Connect to the sidecar's WebSocket IPC. */
  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("WebSocket connect timed out (5s)"));
      }, 5000);

      ws.on("open", () => {
        clearTimeout(timeout);
        this.ws = ws;
        console.log("[EmulatorBridge] WebSocket connected to sidecar");
        resolve();
      });

      ws.on("message", (data) => {
        this.handleSidecarMessage(data.toString());
      });

      ws.on("close", () => {
        if (this.ws === ws) {
          console.warn("[EmulatorBridge] WebSocket closed");
          this.ws = null;
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        console.error("[EmulatorBridge] WebSocket error:", err.message);
        reject(err);
      });
    });
  }

  /** Handle a message from the sidecar. */
  private handleSidecarMessage(raw: string): void {
    let msg: SidecarMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn("[EmulatorBridge] Bad sidecar message:", raw);
      return;
    }

    const sessionId = msg.sessionId;
    if (!sessionId) return;

    const send = this.clientSenders.get(sessionId);
    if (!send) {
      // No client registered for this session (might have disconnected).
      return;
    }

    switch (msg.type) {
      case "webrtc.offer":
        if (msg.sdp) {
          send({
            type: "emulator_webrtc_offer",
            sessionId,
            sdp: msg.sdp,
          });
        }
        break;

      case "webrtc.ice":
        send({
          type: "emulator_ice_candidate_event",
          sessionId,
          candidate: msg.candidate ?? null,
        });
        break;

      case "session.state":
        send({
          type: "emulator_session_state",
          sessionId,
          state: msg.state as
            | "connecting"
            | "connected"
            | "disconnected"
            | "failed",
          error: msg.error,
        });
        break;
    }
  }

  /** Send a JSON message to the sidecar. */
  private sendToSidecar(msg: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[EmulatorBridge] Cannot send: WebSocket not connected");
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  // =========================================================================
  // Public API: Called by relay message router
  // =========================================================================

  /** Register a client's send function for a streaming session. */
  registerClientSender(sessionId: string, send: ClientSendFn): void {
    this.clientSenders.set(sessionId, send);
  }

  /** Unregister a client sender (on disconnect). */
  unregisterClientSender(sessionId: string): void {
    this.clientSenders.delete(sessionId);
  }

  /** Start streaming an emulator to a client. */
  async startStream(
    msg: EmulatorStreamStart,
    send: ClientSendFn,
  ): Promise<void> {
    await this.ensureStarted();
    this.registerClientSender(msg.sessionId, send);

    this.sendToSidecar({
      type: "session.start",
      sessionId: msg.sessionId,
      emulatorId: msg.emulatorId,
      options: msg.options,
    });
  }

  /** Stop streaming. */
  stopStream(msg: EmulatorStreamStop): void {
    this.unregisterClientSender(msg.sessionId);
    this.sendToSidecar({
      type: "session.stop",
      sessionId: msg.sessionId,
    });
  }

  /** Forward SDP answer from client to sidecar. */
  handleAnswer(msg: EmulatorWebRTCAnswer): void {
    this.sendToSidecar({
      type: "webrtc.answer",
      sessionId: msg.sessionId,
      sdp: msg.sdp,
    });
  }

  /** Forward ICE candidate from client to sidecar. */
  handleICE(msg: EmulatorICECandidate): void {
    this.sendToSidecar({
      type: "webrtc.ice",
      sessionId: msg.sessionId,
      candidate: msg.candidate,
    });
  }

  // =========================================================================
  // REST API proxies
  // =========================================================================

  /** List emulators via sidecar REST API. */
  async listEmulators(): Promise<EmulatorInfo[]> {
    await this.ensureStarted();
    const resp = await fetch(`http://127.0.0.1:${this.port}/emulators`);
    if (!resp.ok) {
      throw new Error(`Sidecar error: ${resp.status}`);
    }
    return resp.json();
  }

  /** Get emulator screenshot via sidecar REST API. */
  async getScreenshot(emulatorId: string): Promise<Buffer> {
    await this.ensureStarted();
    const resp = await fetch(
      `http://127.0.0.1:${this.port}/emulators/${emulatorId}/screenshot`,
    );
    if (!resp.ok) {
      throw new Error(`Screenshot error: ${resp.status}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  /** Start an emulator via sidecar REST API. */
  async startEmulator(emulatorId: string): Promise<void> {
    await this.ensureStarted();
    const resp = await fetch(
      `http://127.0.0.1:${this.port}/emulators/${emulatorId}/start`,
      { method: "POST" },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Start error: ${text}`);
    }
  }

  /** Stop an emulator via sidecar REST API. */
  async stopEmulator(emulatorId: string): Promise<void> {
    await this.ensureStarted();
    const resp = await fetch(
      `http://127.0.0.1:${this.port}/emulators/${emulatorId}/stop`,
      { method: "POST" },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Stop error: ${text}`);
    }
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  private cleanup(): void {
    this.available = false;
    this.ws?.close();
    this.ws = null;
    this.port = null;
    this.clientSenders.clear();
  }

  private scheduleRestart(): void {
    if (this.restartAttempts >= this.maxRestartAttempts) {
      console.error(
        `[EmulatorBridge] Max restart attempts (${this.maxRestartAttempts}) reached, giving up`,
      );
      return;
    }

    const delay = Math.min(1000 * 2 ** this.restartAttempts, 30000);
    this.restartAttempts++;
    console.log(
      `[EmulatorBridge] Restarting in ${delay}ms (attempt ${this.restartAttempts})`,
    );

    this.restartTimer = setTimeout(() => {
      this.start().catch((err) => {
        console.error("[EmulatorBridge] Restart failed:", err.message);
      });
    }, delay);
  }

  /** Graceful shutdown. */
  async shutdown(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Try to ask the sidecar to shut down cleanly.
    if (this.port) {
      try {
        await fetch(`http://127.0.0.1:${this.port}/shutdown`, {
          method: "POST",
          signal: AbortSignal.timeout(2000),
        });
      } catch {
        // Sidecar might already be dead.
      }
    }

    // Kill the child process.
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
    }

    this.cleanup();
    this.process = null;
  }
}
