const SHELL_EXECUTABLES = new Set(["bash", "sh", "zsh", "dash"]);

function getExecutableName(token: string): string {
  const normalized = token.replace(/\\/g, "/");
  const name = normalized.split("/").pop() || token;
  return name.toLowerCase();
}

function isShellExecutable(token: string): boolean {
  return SHELL_EXECUTABLES.has(getExecutableName(token));
}

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function getShellLauncherPrefixLength(tokens: string[]): number {
  if (tokens.length < 3) {
    return 0;
  }

  const first = tokens[0] || "";
  const second = tokens[1] || "";
  const third = tokens[2] || "";

  // /usr/bin/env bash -lc "command"
  if (
    getExecutableName(first) === "env" &&
    isShellExecutable(second) &&
    third === "-lc" &&
    tokens.length >= 4
  ) {
    return 3;
  }

  // /bin/bash -lc "command"
  if (isShellExecutable(first) && second === "-lc" && tokens.length >= 3) {
    return 2;
  }

  return 0;
}

export function isShellLauncherWrappedCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  const tokens = tokenizeShellCommand(trimmed);
  const launcherPrefixLength = getShellLauncherPrefixLength(tokens);
  return launcherPrefixLength > 0 && tokens.length > launcherPrefixLength;
}

export function unwrapShellLauncherCommand(command: string): string {
  let normalized = command.trim();

  for (let i = 0; i < 3; i++) {
    const tokens = tokenizeShellCommand(normalized);
    const launcherPrefixLength = getShellLauncherPrefixLength(tokens);
    if (launcherPrefixLength === 0 || tokens.length <= launcherPrefixLength) {
      break;
    }
    normalized = tokens.slice(launcherPrefixLength).join(" ").trim();
  }

  return normalized;
}

export function getRawBashCommandFromInput(input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }

  const candidate = input as Record<string, unknown>;
  if (typeof candidate.command === "string" && candidate.command.trim()) {
    return candidate.command.trim();
  }

  if (typeof candidate.cmd === "string" && candidate.cmd.trim()) {
    return candidate.cmd.trim();
  }

  return "";
}

export function getDisplayBashCommandFromInput(input: unknown): string {
  const raw = getRawBashCommandFromInput(input);
  if (!raw) {
    return "";
  }
  return unwrapShellLauncherCommand(raw);
}

export function isCodexProvider(provider?: string): boolean {
  return provider === "codex" || provider === "codex-oss";
}

export function isCodexLikeBashInput(
  input: unknown,
  provider?: string,
): boolean {
  if (isCodexProvider(provider)) {
    return true;
  }

  const raw = getRawBashCommandFromInput(input);
  if (!raw) {
    return false;
  }

  return isShellLauncherWrappedCommand(raw);
}
