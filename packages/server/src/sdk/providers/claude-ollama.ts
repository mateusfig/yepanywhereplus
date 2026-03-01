/**
 * Claude + Ollama provider.
 *
 * Uses the Claude SDK agent loop (tools, permissions, session persistence)
 * but routes API calls to an Ollama instance via ANTHROPIC_BASE_URL.
 * Ollama 0.14+ natively speaks the Anthropic Messages API.
 */

import type { ModelInfo } from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { ClaudeProvider } from "./claude.js";
import type { AuthStatus } from "./types.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

/** Ollama /api/tags response shape */
interface OllamaTagsResponse {
  models: Array<{
    name: string;
    size: number;
    modified_at: string;
  }>;
}

/**
 * Claude + Ollama provider.
 * Extends ClaudeProvider, overriding env injection and model discovery.
 */
export class ClaudeOllamaProvider extends ClaudeProvider {
  override readonly name = "claude-ollama" as const;
  override readonly displayName = "Claude + Ollama";

  /** Configurable Ollama URL. Defaults to OLLAMA_URL env or localhost:11434. */
  private static ollamaUrl = process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL;

  /** Custom system prompt override (undefined = use default minimal prompt). */
  private static customSystemPrompt: string | undefined;

  /**
   * Update the Ollama URL at runtime (called from settings route).
   */
  static setOllamaUrl(url: string): void {
    ClaudeOllamaProvider.ollamaUrl = url;
  }

  /**
   * Get the current Ollama URL.
   */
  static getOllamaUrl(): string {
    return ClaudeOllamaProvider.ollamaUrl;
  }

  /**
   * Update the custom system prompt at runtime (called from settings route).
   */
  static setSystemPrompt(prompt: string | undefined): void {
    ClaudeOllamaProvider.customSystemPrompt = prompt;
  }

  /**
   * Check if Ollama is reachable by pinging its API.
   */
  override async isInstalled(): Promise<boolean> {
    try {
      const response = await fetch(
        `${ClaudeOllamaProvider.ollamaUrl}/api/tags`,
        { signal: AbortSignal.timeout(3000) },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * No authentication needed for Ollama.
   */
  override async isAuthenticated(): Promise<boolean> {
    return this.isInstalled();
  }

  override async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    return {
      installed,
      authenticated: installed,
      enabled: installed,
    };
  }

  /**
   * Fetch available models from Ollama's HTTP API.
   * Works over SSH tunnels (unlike `ollama list` CLI).
   */
  override async getAvailableModels(): Promise<ModelInfo[]> {
    const log = getLogger();
    try {
      const response = await fetch(
        `${ClaudeOllamaProvider.ollamaUrl}/api/tags`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!response.ok) {
        return [];
      }
      const data = (await response.json()) as OllamaTagsResponse;
      return (data.models ?? []).map((m) => ({
        id: m.name,
        name: m.name,
        size: m.size,
      }));
    } catch (error) {
      log.debug({ error }, "Failed to fetch Ollama models");
      return [];
    }
  }

  /**
   * Use a minimal system prompt that local models can actually follow.
   * The full claude_code preset is far too complex for most Ollama models
   * and causes them to get stuck in tool-calling loops.
   */
  protected override getSystemPrompt(globalInstructions?: string): string {
    const base =
      ClaudeOllamaProvider.customSystemPrompt ||
      "You are a helpful coding assistant. You help users with software engineering tasks. You have access to tools for reading files, editing files, running shell commands, and searching code. Use tools when needed to answer questions or make changes. Be concise and direct.";
    return globalInstructions ? `${base}\n\n${globalInstructions}` : base;
  }

  /**
   * Inject ANTHROPIC_BASE_URL pointing at Ollama into the child process env.
   */
  protected override getEnv(): Record<string, string | undefined> {
    return {
      ...super.getEnv(),
      ANTHROPIC_BASE_URL: ClaudeOllamaProvider.ollamaUrl,
      ANTHROPIC_AUTH_TOKEN: "ollama",
    };
  }
}

/** Singleton instance */
export const claudeOllamaProvider = new ClaudeOllamaProvider();
