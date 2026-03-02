import type { EmulatorInfo } from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { EmulatorNavButtons } from "../components/EmulatorNavButtons";
import { EmulatorStream } from "../components/EmulatorStream";
import { PageHeader } from "../components/PageHeader";
import { useEmulatorStream } from "../hooks/useEmulatorStream";
import { useEmulators } from "../hooks/useEmulators";
import { useVersion } from "../hooks/useVersion";
import { useNavigationLayout } from "../layouts";

function EmulatorListItem({
  emulator,
  onConnect,
  onStart,
  onStop,
}: {
  emulator: EmulatorInfo;
  onConnect: (id: string) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
}) {
  const isRunning = emulator.state === "running";

  return (
    <div className="emulator-list-item">
      <div className="emulator-list-item-info">
        <span className="emulator-list-item-name">{emulator.avd}</span>
        <span
          className={`emulator-list-item-status ${isRunning ? "running" : "stopped"}`}
        >
          {emulator.state}
        </span>
      </div>
      <div className="emulator-list-item-actions">
        {isRunning ? (
          <>
            <button
              type="button"
              className="emulator-btn emulator-btn-primary"
              onClick={() => onConnect(emulator.id)}
            >
              Connect
            </button>
            <button
              type="button"
              className="emulator-btn emulator-btn-secondary"
              onClick={() => onStop(emulator.id)}
            >
              Stop
            </button>
          </>
        ) : (
          <button
            type="button"
            className="emulator-btn emulator-btn-secondary"
            onClick={() => onStart(emulator.id)}
          >
            Start
          </button>
        )}
      </div>
    </div>
  );
}

function StreamView({
  emulatorId,
  onBack,
}: { emulatorId: string; onBack: () => void }) {
  const {
    remoteStream,
    dataChannel,
    peerConnection,
    connectionState,
    error,
    connect,
    disconnect,
  } = useEmulatorStream();

  // Auto-connect when entering stream view
  useEffect(() => {
    connect(emulatorId);
    return () => disconnect();
  }, [emulatorId, connect, disconnect]);

  const handleBack = () => {
    disconnect();
    onBack();
  };

  return (
    <div className="emulator-stream-view">
      <div className="emulator-stream-header">
        <button
          type="button"
          className="emulator-btn emulator-btn-secondary"
          onClick={handleBack}
        >
          Back
        </button>
        <span className="emulator-connection-state">{connectionState}</span>
      </div>

      {error && <div className="emulator-error">{error}</div>}

      {connectionState === "connecting" && (
        <div className="emulator-connecting">Connecting...</div>
      )}

      <div className="emulator-stream-container">
        <EmulatorStream stream={remoteStream} dataChannel={dataChannel} peerConnection={peerConnection} />
      </div>

      <EmulatorNavButtons dataChannel={dataChannel} />
    </div>
  );
}

function DownloadPrompt({ onDownloaded }: { onDownloaded: () => void }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      const result = await api.downloadEmulatorBridge();
      if (result.ok) {
        onDownloaded();
      } else {
        setError(result.error ?? "Download failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="emulator-download-prompt">
      <p>Emulator streaming requires the emulator bridge binary (~17 MB).</p>
      {error && <div className="emulator-error">{error}</div>}
      <button
        type="button"
        className="emulator-btn emulator-btn-primary"
        onClick={handleDownload}
        disabled={downloading}
      >
        {downloading ? "Downloading..." : "Download Bridge"}
      </button>
    </div>
  );
}

export function EmulatorPage() {
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const { version: versionInfo, refetch: refetchVersion } = useVersion();
  const capabilities = versionInfo?.capabilities ?? [];
  const needsDownload =
    capabilities.includes("emulator-download") &&
    !capabilities.includes("emulator");

  const { emulators, loading, error, startEmulator, stopEmulator } =
    useEmulators({ enabled: !needsDownload });
  const [activeEmulatorId, setActiveEmulatorId] = useState<string | null>(null);

  // ?auto — auto-connect to the first running emulator
  useEffect(() => {
    if (activeEmulatorId || loading || needsDownload) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("auto")) return;
    const running = emulators.find((e) => e.state === "running");
    if (running) setActiveEmulatorId(running.id);
  }, [emulators, loading, activeEmulatorId, needsDownload]);

  if (activeEmulatorId) {
    return (
      <div className="main-content-wrapper">
        <div className="main-content-constrained">
          <StreamView
            emulatorId={activeEmulatorId}
            onBack={() => setActiveEmulatorId(null)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="main-content-wrapper">
      <div className="main-content-constrained">
        <PageHeader
          title="Emulator"
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />
        <main className="page-scroll-container">
          <div className="page-content-inner">
            {needsDownload ? (
              <DownloadPrompt onDownloaded={refetchVersion} />
            ) : (
              <>
                {loading && <div className="emulator-loading">Loading...</div>}
                {error && <div className="emulator-error">{error}</div>}
                {!loading && emulators.length === 0 && (
                  <div className="emulator-empty">
                    No emulators detected. Make sure ADB is running and
                    emulators are available.
                  </div>
                )}
                {emulators.length > 0 && (
                  <div className="emulator-list">
                    {emulators.map((emu) => (
                      <EmulatorListItem
                        key={emu.id}
                        emulator={emu}
                        onConnect={setActiveEmulatorId}
                        onStart={startEmulator}
                        onStop={stopEmulator}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
