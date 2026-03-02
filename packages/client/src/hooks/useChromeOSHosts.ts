import { useCallback, useState } from "react";
import {
  addChromeOSHost,
  listChromeOSHosts,
  removeChromeOSHost,
} from "../lib/chromeOsHosts";

export function useChromeOSHosts() {
  const [hosts, setHosts] = useState<string[]>(() => listChromeOSHosts());
  const [error, setError] = useState<string | null>(null);

  const addHost = useCallback((value: string) => {
    const result = addChromeOSHost(value);
    setHosts(result.hosts);
    setError(result.error ?? null);
    return result.ok;
  }, []);

  const removeHost = useCallback((value: string) => {
    const next = removeChromeOSHost(value);
    setHosts(next);
    setError(null);
  }, []);

  const reload = useCallback(() => {
    setHosts(listChromeOSHosts());
    setError(null);
  }, []);

  return { hosts, error, addHost, removeHost, reload };
}
