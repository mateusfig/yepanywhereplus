import { useChromeOSHosts } from "../../hooks/useChromeOSHosts";
import {
  EMULATOR_FPS_OPTIONS,
  EMULATOR_WIDTH_OPTIONS,
  type EmulatorQuality,
  getQualityLabel,
  useEmulatorSettings,
} from "../../hooks/useEmulatorSettings";
import { useEmulators } from "../../hooks/useEmulators";

const QUALITY_OPTIONS: EmulatorQuality[] = ["high", "medium", "low"];

function canStartDevice(type: string, state: string, actions?: string[]) {
  if (actions?.length) return actions.includes("start");
  return type === "emulator" && state === "stopped";
}

function canStopDevice(type: string, state: string, actions?: string[]) {
  if (actions?.length) return actions.includes("stop");
  return type === "emulator" && state !== "stopped";
}

/**
 * Settings section for the device bridge.
 * Shows discovered devices, stream settings, and ChromeOS host aliases.
 */
export function EmulatorSettings() {
  const { emulators, loading, error, startEmulator, stopEmulator, refresh } =
    useEmulators();
  const {
    maxFps,
    setMaxFps,
    maxWidth,
    setMaxWidth,
    quality,
    setQuality,
    adaptiveFps,
    setAdaptiveFps,
  } = useEmulatorSettings();
  const {
    hosts: chromeOsHosts,
    error: chromeOsHostError,
    addHost,
    removeHost,
  } = useChromeOSHosts();

  return (
    <section className="settings-section">
      <h2>Device Bridge</h2>
      <p className="settings-description">
        Stream and control Android emulators, Android devices, and ChromeOS
        testbeds from your phone via WebRTC.
      </p>

      <div className="settings-group">
        <h3>Stream Quality</h3>
        <p className="settings-description">
          Changes take effect on the next connection.
        </p>

        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Frame Rate</strong>
            <p>Higher frame rates increase CPU and bandwidth usage.</p>
          </div>
          <div className="font-size-selector">
            {EMULATOR_FPS_OPTIONS.map((fps) => (
              <button
                key={fps}
                type="button"
                className={`font-size-option ${maxFps === fps ? "active" : ""}`}
                onClick={() => setMaxFps(fps)}
              >
                {fps} fps
              </button>
            ))}
          </div>
        </div>

        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Resolution</strong>
            <p>
              Maximum stream width in pixels (height scales proportionally).
            </p>
          </div>
          <div className="font-size-selector">
            {EMULATOR_WIDTH_OPTIONS.map((w) => (
              <button
                key={w}
                type="button"
                className={`font-size-option ${maxWidth === w ? "active" : ""}`}
                onClick={() => setMaxWidth(w)}
              >
                {w}p
              </button>
            ))}
          </div>
        </div>

        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Quality</strong>
            <p>
              High uses ~4 Mbps, Medium ~2.8 Mbps, Low ~1.5 Mbps at 720p/30fps.
            </p>
          </div>
          <div className="font-size-selector">
            {QUALITY_OPTIONS.map((q) => (
              <button
                key={q}
                type="button"
                className={`font-size-option ${quality === q ? "active" : ""}`}
                onClick={() => setQuality(q)}
              >
                {getQualityLabel(q)}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Adaptive Frame Rate</strong>
            <p>
              Automatically reduces frame rate when packet loss is detected, and
              restores it once the connection recovers.
            </p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={adaptiveFps}
              onChange={(e) => setAdaptiveFps(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      <div className="settings-group">
        <h3>ChromeOS Hosts</h3>
        <p className="settings-description">
          Add SSH host aliases from your local SSH config (for example,
          <code> chromeroot</code>). They appear in the device list as
          streamable ChromeOS targets.
        </p>

        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Add Host Alias</strong>
            <p>Host alias only, no spaces.</p>
          </div>
          <form
            className="settings-item-actions"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const input = form.elements.namedItem("chromeosHost");
              if (!(input instanceof HTMLInputElement)) return;
              if (addHost(input.value)) {
                input.value = "";
                void refresh();
              }
            }}
          >
            <input
              type="text"
              name="chromeosHost"
              placeholder="chromeroot"
              className="settings-select"
              autoComplete="off"
            />
            <button type="submit" className="settings-button">
              Add
            </button>
          </form>
        </div>

        {chromeOsHostError && (
          <p className="settings-error">{chromeOsHostError}</p>
        )}

        {chromeOsHosts.length === 0 ? (
          <p className="settings-muted">No custom ChromeOS host aliases yet.</p>
        ) : (
          chromeOsHosts.map((host) => (
            <div key={host} className="settings-item">
              <div className="settings-item-info">
                <span className="settings-item-label">{host}</span>
                <span className="settings-item-description">
                  Device ID: chromeos:{host}
                </span>
              </div>
              <div className="settings-item-action">
                <button
                  type="button"
                  className="settings-button"
                  onClick={() => {
                    removeHost(host);
                    void refresh();
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="settings-group">
        <h3>Discovered Devices</h3>

        {loading && <p className="settings-muted">Loading...</p>}
        {error && <p className="settings-error">{error}</p>}

        {!loading && emulators.length === 0 && (
          <p className="settings-muted">
            No devices found. Ensure ADB is on your PATH and emulators/devices
            are available.
          </p>
        )}

        {emulators.map((device) => (
          <div key={device.id} className="settings-item">
            <div className="settings-item-info">
              <span className="settings-item-label">
                {device.label || device.avd || device.id}
              </span>
              <span className="settings-item-description">
                {device.type} - {device.id} - {device.state}
              </span>
            </div>
            <div className="settings-item-action">
              {canStopDevice(device.type, device.state, device.actions) ? (
                <button
                  type="button"
                  className="settings-button"
                  onClick={() => stopEmulator(device.id)}
                >
                  Stop
                </button>
              ) : canStartDevice(device.type, device.state, device.actions) ? (
                <button
                  type="button"
                  className="settings-button"
                  onClick={() => startEmulator(device.id)}
                >
                  Start
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
