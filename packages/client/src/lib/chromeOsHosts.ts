import type { DeviceInfo } from "@yep-anywhere/shared";
import { getServerScoped, setServerScoped } from "./storageKeys";

const LEGACY_CHROMEOS_HOSTS_KEY = "yep-anywhere-chromeos-hosts";

function normalizeHost(input: string): string {
  return input.trim();
}

function uniqueHosts(hosts: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const host of hosts) {
    const normalized = normalizeHost(host);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function loadHostsRaw(): string[] {
  const raw = getServerScoped("chromeOsHosts", LEGACY_CHROMEOS_HOSTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return uniqueHosts(
      parsed.filter((v): v is string => typeof v === "string"),
    );
  } catch {
    return [];
  }
}

function saveHostsRaw(hosts: string[]): void {
  setServerScoped(
    "chromeOsHosts",
    JSON.stringify(uniqueHosts(hosts)),
    LEGACY_CHROMEOS_HOSTS_KEY,
  );
}

export function listChromeOSHosts(): string[] {
  return loadHostsRaw();
}

export function addChromeOSHost(host: string): {
  ok: boolean;
  hosts: string[];
  error?: string;
} {
  const normalized = normalizeHost(host);
  if (!normalized) {
    return {
      ok: false,
      hosts: loadHostsRaw(),
      error: "Host alias is required",
    };
  }
  if (/\s/.test(normalized)) {
    return {
      ok: false,
      hosts: loadHostsRaw(),
      error: "Host alias cannot contain spaces",
    };
  }

  const existing = loadHostsRaw();
  const duplicate = existing.some(
    (item) => item.toLowerCase() === normalized.toLowerCase(),
  );
  if (duplicate) {
    return { ok: true, hosts: existing };
  }

  const next = [...existing, normalized];
  saveHostsRaw(next);
  return { ok: true, hosts: next };
}

export function removeChromeOSHost(host: string): string[] {
  const normalized = normalizeHost(host);
  const next = loadHostsRaw().filter(
    (item) => item.toLowerCase() !== normalized.toLowerCase(),
  );
  saveHostsRaw(next);
  return next;
}

export function mergeConfiguredChromeOSHosts(
  devices: DeviceInfo[],
  hosts: string[],
): DeviceInfo[] {
  const existingIds = new Set(devices.map((d) => d.id));
  const additions: DeviceInfo[] = [];

  for (const host of uniqueHosts(hosts)) {
    const id = `chromeos:${host}`;
    if (existingIds.has(id)) continue;
    additions.push({
      id,
      label: `ChromeOS (${host})`,
      type: "chromeos",
      state: "connected",
      actions: ["stream"],
      avd: `ChromeOS (${host})`,
    });
  }

  return [...devices, ...additions];
}
