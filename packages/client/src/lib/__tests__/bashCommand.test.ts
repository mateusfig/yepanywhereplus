import { describe, expect, it } from "vitest";
import {
  getDisplayBashCommandFromInput,
  isCodexLikeBashInput,
  isShellLauncherWrappedCommand,
  unwrapShellLauncherCommand,
} from "../bashCommand";

describe("bashCommand", () => {
  it("unwraps bash -lc wrappers for display", () => {
    expect(
      unwrapShellLauncherCommand("/opt/homebrew/bin/bash -lc 'npm run lint'"),
    ).toBe("npm run lint");
    expect(
      unwrapShellLauncherCommand(
        '/bin/bash -lc "cat packages/server/package.json"',
      ),
    ).toBe("cat packages/server/package.json");
  });

  it("unwraps env + shell wrappers for display", () => {
    expect(
      unwrapShellLauncherCommand(
        '/usr/bin/env bash -lc "rg --files packages/client/src"',
      ),
    ).toBe("rg --files packages/client/src");
  });

  it("detects shell launcher wrappers", () => {
    expect(
      isShellLauncherWrappedCommand(
        "/opt/homebrew/bin/bash -lc 'npm run lint'",
      ),
    ).toBe(true);
    expect(
      isShellLauncherWrappedCommand(
        '/usr/bin/env bash -lc "rg --files packages/client/src"',
      ),
    ).toBe(true);
    expect(isShellLauncherWrappedCommand("npm run lint")).toBe(false);
  });

  it("reads both command and cmd fields", () => {
    expect(
      getDisplayBashCommandFromInput({ command: "/bin/bash -lc 'echo hi'" }),
    ).toBe("echo hi");
    expect(getDisplayBashCommandFromInput({ cmd: "pnpm typecheck" })).toBe(
      "pnpm typecheck",
    );
  });

  it("treats wrapped commands as codex-like when provider is missing", () => {
    expect(
      isCodexLikeBashInput({
        command: "/opt/homebrew/bin/bash -lc 'npm run lint'",
      }),
    ).toBe(true);
    expect(isCodexLikeBashInput({ command: "npm run lint" })).toBe(false);
    expect(isCodexLikeBashInput({ command: "npm run lint" }, "codex-oss")).toBe(
      true,
    );
  });
});
