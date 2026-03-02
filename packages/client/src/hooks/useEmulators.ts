import type { DeviceAction, DeviceInfo } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import {
  listChromeOSHosts,
  mergeConfiguredChromeOSHosts,
} from "../lib/chromeOsHosts";

interface UseEmulatorsResult {
  emulators: DeviceInfo[];
  loading: boolean;
  error: string | null;
  startEmulator: (id: string) => Promise<void>;
  stopEmulator: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

interface UseEmulatorsOptions {
  /** Polling interval in ms (default 5000). */
  pollIntervalMs?: number;
  /** Whether to enable polling (default true). Set false to skip API calls. */
  enabled?: boolean;
}

/** Max backoff interval when errors occur (30s). */
const MAX_BACKOFF_MS = 30_000;

function inferType(id: string): DeviceInfo["type"] {
  if (id.startsWith("chromeos:") || id === "chromeos") return "chromeos";
  if (id.startsWith("emulator-") || id.startsWith("avd-")) return "emulator";
  if (id.startsWith("ios-sim:")) return "ios-simulator";
  return "android";
}

function inferActions(
  type: DeviceInfo["type"],
  state: DeviceInfo["state"],
): DeviceAction[] {
  if (type === "emulator") {
    if (state === "stopped") return ["start"];
    return ["stream", "stop", "screenshot"];
  }
  return ["stream"];
}

function normalizeDeviceInfo(device: DeviceInfo): DeviceInfo {
  const type = device.type ?? inferType(device.id);
  const state = device.state ?? "running";
  return {
    ...device,
    label: device.label || device.avd || device.id,
    type,
    state,
    actions:
      device.actions && device.actions.length > 0
        ? device.actions
        : inferActions(type, state),
  };
}

/**
 * Hook to fetch and manage emulator list.
 * Polls every `pollIntervalMs` (default 5s) while active.
 * Backs off on consecutive errors to avoid flooding the server.
 */
export function useEmulators(
  options?: UseEmulatorsOptions | number,
): UseEmulatorsResult {
  const pollIntervalMs =
    typeof options === "number" ? options : (options?.pollIntervalMs ?? 5000);
  const enabled =
    typeof options === "number" ? true : (options?.enabled ?? true);
  const [emulators, setEmulators] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const consecutiveErrorsRef = useRef(0);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    // Skip if a request is already in flight (prevents piling up)
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const result = await api.getDevices();
      if (mountedRef.current) {
        const normalized = result.map(normalizeDeviceInfo);
        setEmulators(
          mergeConfiguredChromeOSHosts(normalized, listChromeOSHosts()),
        );
        setError(null);
        consecutiveErrorsRef.current = 0;
      }
    } catch (err) {
      if (mountedRef.current) {
        consecutiveErrorsRef.current++;
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const startEmulator = useCallback(
    async (id: string) => {
      try {
        await api.startDevice(id);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  const stopEmulator = useCallback(
    async (id: string) => {
      try {
        await api.stopDevice(id);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  useEffect(() => {
    if (!enabled) return;
    mountedRef.current = true;
    consecutiveErrorsRef.current = 0;
    refresh();

    // Use dynamic interval with backoff on errors
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const backoff =
        consecutiveErrorsRef.current > 0
          ? Math.min(
              pollIntervalMs * 2 ** consecutiveErrorsRef.current,
              MAX_BACKOFF_MS,
            )
          : pollIntervalMs;
      timer = setTimeout(() => {
        refresh().then(schedule);
      }, backoff);
    };
    schedule();

    return () => {
      mountedRef.current = false;
      clearTimeout(timer);
    };
  }, [refresh, pollIntervalMs, enabled]);

  return { emulators, loading, error, startEmulator, stopEmulator, refresh };
}
