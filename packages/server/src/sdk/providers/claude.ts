import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type SDKMessage as AgentSDKMessage,
  type Query,
  type CanUseTool as SDKCanUseTool,
  type SpawnedProcess,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import type { ModelInfo, SlashCommand } from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { detectClaudeCli } from "../cli-detection.js";
import { logSDKMessage } from "../messageLogger.js";
import { MessageQueue } from "../messageQueue.js";
import {
  checkRemotePath,
  createRemoteSpawn,
  getRemoteHome,
  testSSHConnection,
  translateHomePath,
} from "../remote-spawn.js";
import { getProjectDirFromCwd, syncSessionFile } from "../session-sync.js";
import type { ContentBlock, SDKMessage } from "../types.js";
import { filterEnvForChildProcess } from "./env-filter.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  ProviderName,
  StartSessionOptions,
} from "./types.js";

/**
 * Use a spawn wrapper to capture the child process reference for liveness checks.
 * When true, stale detection can distinguish "process died silently" from
 * "process is busy with a long tool call". Set to false to revert to the
 * old time-only heuristic if the wrapper causes issues.
 */
const USE_SPAWN_WRAPPER = true;

/** Static fallback list of Claude models (used if probe fails) */
const CLAUDE_MODELS_FALLBACK: ModelInfo[] = [
  {
    id: "sonnet",
    name: "Sonnet",
    description: "Best balance of speed and capability",
  },
  {
    id: "opus",
    name: "Opus",
    description: "Most capable model for complex tasks",
  },
  { id: "haiku", name: "Haiku", description: "Fastest model for simple tasks" },
];

/** Cached models from SDK probe */
let cachedModels: ModelInfo[] | null = null;

/** Promise for in-flight probe (to avoid duplicate probes) */
let probePromise: Promise<ModelInfo[]> | null = null;

/**
 * Claude provider implementation using @anthropic-ai/claude-agent-sdk.
 *
 * This class wraps the SDK's query() function and provides:
 * - MessageQueue for queuing user messages
 * - AbortController for cancellation
 * - Tool approval callbacks
 */
export class ClaudeProvider implements AgentProvider {
  readonly name: ProviderName = "claude";
  readonly displayName: string = "Claude";
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle = true;
  readonly supportsSlashCommands = true;

  /**
   * Check if Claude SDK is available.
   * Since we bundle the SDK, this is always true.
   */
  async isInstalled(): Promise<boolean> {
    return true;
  }

  /**
   * Check if Claude is authenticated.
   * Returns true if ANTHROPIC_API_KEY is set or OAuth credentials exist.
   */
  async isAuthenticated(): Promise<boolean> {
    const authStatus = await this.getAuthStatus();
    return authStatus.authenticated;
  }

  /**
   * Get detailed authentication status.
   * If Claude CLI is installed, assume it's authenticated.
   * The SDK handles auth internally and will error at session start if not authenticated.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isClaudeCliInstalled();
    return {
      installed,
      authenticated: installed,
      enabled: installed,
    };
  }

  /**
   * Check if Claude CLI is installed.
   * Uses detectClaudeCli() which checks PATH and common installation locations.
   */
  private async isClaudeCliInstalled(): Promise<boolean> {
    const cliInfo = detectClaudeCli();
    return cliInfo.found;
  }

  /**
   * Get available Claude models.
   * Fetches dynamically from SDK via a probe session, with caching.
   * Falls back to static list if probe fails or user is not authenticated.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    // Return cached models if available
    if (cachedModels) {
      return cachedModels;
    }

    // Check if user is authenticated before trying to probe
    const authStatus = await this.getAuthStatus();
    if (!authStatus.authenticated) {
      return CLAUDE_MODELS_FALLBACK;
    }

    // If probe is already in progress, wait for it
    if (probePromise) {
      return probePromise;
    }

    // Start a new probe
    probePromise = this.probeModels();
    try {
      const models = await probePromise;
      cachedModels = models;
      return models;
    } catch (error) {
      console.warn("[Claude] Failed to probe models, using fallback:", error);
      return CLAUDE_MODELS_FALLBACK;
    } finally {
      probePromise = null;
    }
  }

  /**
   * Get filtered environment variables for child processes.
   * Subclasses can override to inject custom env vars (e.g., ANTHROPIC_BASE_URL).
   */
  protected getEnv(): Record<string, string | undefined> {
    return filterEnvForChildProcess();
  }

  /**
   * Build the systemPrompt option for the SDK query.
   * Default: use the full claude_code preset. Subclasses (e.g., Ollama) can
   * override to provide a simpler prompt that smaller models can follow.
   */
  protected getSystemPrompt(
    globalInstructions?: string,
  ):
    | string
    | { type: "preset"; preset: "claude_code"; append?: string }
    | undefined {
    return globalInstructions
      ? {
          type: "preset" as const,
          preset: "claude_code" as const,
          append: globalInstructions,
        }
      : { type: "preset" as const, preset: "claude_code" as const };
  }

  /**
   * Probe for available models by starting a minimal session.
   * The session doesn't send any messages - it just calls supportedModels()
   * on the SDK query and then aborts.
   */
  private async probeModels(): Promise<ModelInfo[]> {
    const abortController = new AbortController();

    // Create a generator that never yields (session waits for messages)
    async function* emptyGenerator(): AsyncGenerator<never> {
      // Never yield - just wait indefinitely
      await new Promise(() => {});
    }

    try {
      const sdkQuery = query({
        prompt: emptyGenerator(),
        options: {
          cwd: homedir(), // Use home dir as neutral working directory
          abortController,
          permissionMode: "default",
          // Don't persist this probe session to disk
          persistSession: false,
          env: this.getEnv(),
        },
      });

      // Get models from SDK initialization
      const models = await sdkQuery.supportedModels();

      // Map SDK ModelInfo to our ModelInfo format
      return models.map((m) => ({
        id: m.value,
        name: m.displayName,
        description: m.description,
      }));
    } finally {
      // Always abort the probe session
      abortController.abort();
    }
  }

  /**
   * Start a new Claude session.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const log = getLogger();
    const queue = new MessageQueue();
    const abortController = new AbortController();

    // Effective cwd for the session (may be translated for remote executors)
    let effectiveCwd = options.cwd;

    // If remote executor specified, test connection first
    if (options.executor) {
      log.info(
        {
          event: "remote_session_start",
          executor: options.executor,
          cwd: options.cwd,
        },
        `Starting remote session on ${options.executor}`,
      );

      const testResult = await testSSHConnection(options.executor);
      if (!testResult.success) {
        throw new Error(
          `SSH connection to ${options.executor} failed: ${testResult.error}`,
        );
      }
      if (!testResult.claudeAvailable) {
        throw new Error(
          `Claude CLI not found on ${options.executor}. Install with: curl -fsSL https://claude.ai/install.sh | bash`,
        );
      }

      // Translate the working directory path for the remote host
      // (e.g., /home/user/... on Linux -> /Users/user/... on macOS)
      if (options.cwd) {
        const remoteHome = await getRemoteHome(options.executor);
        if (remoteHome) {
          const localHome = homedir();
          effectiveCwd = translateHomePath(options.cwd, localHome, remoteHome);
          if (effectiveCwd !== options.cwd) {
            log.info(
              {
                event: "remote_path_translated",
                executor: options.executor,
                localPath: options.cwd,
                remotePath: effectiveCwd,
                localHome,
                remoteHome,
              },
              `Translated path for ${options.executor}: ${options.cwd} -> ${effectiveCwd}`,
            );
          }
        }

        // Check if the (translated) working directory exists on the remote
        const pathCheck = await checkRemotePath(options.executor, effectiveCwd);
        if (!pathCheck.exists) {
          throw new Error(
            `Directory does not exist on ${options.executor}: ${effectiveCwd}`,
          );
        }
      }
    }

    // Push the initial message into the queue (if provided)
    // If no message, the agent will wait until one is pushed
    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    // Wrap our canUseTool to match SDK's expected type
    const onToolApproval = options.onToolApproval;
    const canUseTool: SDKCanUseTool | undefined = onToolApproval
      ? async (toolName, input, opts) => {
          console.log(`[canUseTool] Called for tool: ${toolName}`);
          const result = await onToolApproval(toolName, input, opts);
          console.log(
            `[canUseTool] Result for ${toolName}: ${result.behavior}`,
          );
          // Convert our result to SDK's PermissionResult format
          if (result.behavior === "allow") {
            return {
              behavior: "allow" as const,
              updatedInput: (result.updatedInput ?? input) as Record<
                string,
                unknown
              >,
            };
          }
          return {
            behavior: "deny" as const,
            message: result.message ?? "Permission denied",
            interrupt: result.interrupt,
          };
        }
      : undefined;

    // Create spawn function: remote spawn for SSH executors, local wrapper for liveness checks
    let spawnClaudeCodeProcess:
      | ((
          opts: import("@anthropic-ai/claude-agent-sdk").SpawnOptions,
        ) => SpawnedProcess)
      | undefined;
    let capturedProcess: SpawnedProcess | null = null;

    if (options.executor) {
      spawnClaudeCodeProcess = createRemoteSpawn({
        host: options.executor,
        remoteEnv: options.remoteEnv,
      });
    } else if (USE_SPAWN_WRAPPER) {
      // Local spawn wrapper: delegates to child_process.spawn but captures the
      // SpawnedProcess reference so we can check liveness (exitCode) later.
      spawnClaudeCodeProcess = (spawnOpts) => {
        const proc = spawn(spawnOpts.command, spawnOpts.args, {
          cwd: spawnOpts.cwd,
          env: spawnOpts.env as NodeJS.ProcessEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });

        // Wire up abort signal → SIGTERM, matching remote-spawn behavior
        const abortHandler = () => {
          proc.kill("SIGTERM");
        };
        spawnOpts.signal.addEventListener("abort", abortHandler);
        proc.on("exit", () => {
          spawnOpts.signal.removeEventListener("abort", abortHandler);
        });

        capturedProcess = proc;
        return proc;
      };
    }

    // Create the SDK query with our message generator
    let sdkQuery: Query;
    try {
      sdkQuery = query({
        prompt: queue.generator(),
        options: {
          cwd: effectiveCwd,
          resume: options.resumeSessionId,
          abortController,
          // Pass permission mode to SDK for system prompt configuration.
          // However, for "bypassPermissions" we pass "default" to the SDK so it always
          // calls our canUseTool callback - we handle the bypass logic ourselves to
          // allow exceptions (e.g., always prompting for AskUserQuestion/ExitPlanMode).
          permissionMode:
            options.permissionMode === "bypassPermissions"
              ? "default"
              : (options.permissionMode ?? "default"),
          canUseTool,
          systemPrompt: this.getSystemPrompt(options.globalInstructions),
          settingSources: ["user", "project", "local"],
          includePartialMessages: true,
          // Model, thinking, and effort options
          model: options.model,
          thinking: options.thinking,
          effort: options.effort,
          // Filter env to exclude npm_*, yep-anywhere specific, and other irrelevant vars
          env: this.getEnv(),
          // Remote execution via SSH
          spawnClaudeCodeProcess,
        },
      });
    } catch (error) {
      // Handle common SDK initialization errors
      if (error instanceof Error) {
        if (error.message.includes("Claude Code executable not found")) {
          throw new Error(
            "Claude CLI not installed. Run: curl -fsSL https://claude.ai/install.sh | bash",
          );
        }
        if (
          error.message.includes("SPAWN") ||
          error.message.includes("spawn")
        ) {
          throw new Error(
            `Failed to spawn Claude CLI process: ${error.message}`,
          );
        }
      }
      throw error;
    }

    // Wrap the iterator to convert SDK message types to our internal types
    // Pass executor info for session sync after result messages
    // Use effectiveCwd (the translated remote path) so sync uses the correct project dir
    const wrappedIterator = this.wrapIterator(sdkQuery, {
      executor: options.executor,
      cwd: effectiveCwd,
      remoteEnv: options.remoteEnv,
    });

    return {
      iterator: wrappedIterator,
      queue,
      abort: () => abortController.abort(),
      isProcessAlive:
        USE_SPAWN_WRAPPER && !options.executor
          ? () =>
              capturedProcess !== null &&
              capturedProcess.exitCode === null &&
              !capturedProcess.killed
          : undefined,
      setMaxThinkingTokens: (tokens: number | null) =>
        sdkQuery.setMaxThinkingTokens(tokens),
      interrupt: () => sdkQuery.interrupt(),
      supportedModels: async (): Promise<ModelInfo[]> => {
        const models = await sdkQuery.supportedModels();
        // Map SDK ModelInfo (value, displayName, description) to our ModelInfo (id, name, description)
        const mappedModels = models.map((m) => ({
          id: m.value,
          name: m.displayName,
          description: m.description,
        }));
        // Update cache for future getAvailableModels() calls
        cachedModels = mappedModels;
        return mappedModels;
      },
      supportedCommands: async (): Promise<SlashCommand[]> => {
        const commands = await sdkQuery.supportedCommands();
        // Map SDK SlashCommand to our SlashCommand (same fields, just normalize)
        return commands.map((c) => ({
          name: c.name,
          description: c.description,
          argumentHint: c.argumentHint || undefined,
        }));
      },
      setModel: (model?: string) => sdkQuery.setModel(model),
    };
  }

  /**
   * Wrap the SDK iterator to convert message types.
   * The SDK emits its own message types which we convert to our SDKMessage type.
   *
   * For remote sessions, syncs session files after each result message.
   */
  private async *wrapIterator(
    iterator: AsyncIterable<AgentSDKMessage>,
    remoteOptions?: {
      executor?: string;
      cwd: string;
      remoteEnv?: Record<string, string>;
    },
  ): AsyncIterableIterator<SDKMessage> {
    const log = getLogger();
    let sessionId = "unknown";

    try {
      for await (const message of iterator) {
        // Log raw SDK message for analysis (if LOG_SDK_MESSAGES=true)
        sessionId =
          (message as { session_id?: string }).session_id ?? sessionId;
        logSDKMessage(sessionId, message);

        const converted = this.convertMessage(message);
        yield converted;

        // For remote sessions, sync session files after result messages
        // This keeps the local UI up-to-date with remote progress
        if (
          remoteOptions?.executor &&
          converted.type === "result" &&
          sessionId !== "unknown"
        ) {
          const projectDir = getProjectDirFromCwd(remoteOptions.cwd);
          log.debug(
            {
              event: "remote_session_sync",
              executor: remoteOptions.executor,
              sessionId,
              projectDir,
            },
            "Syncing session from remote after turn",
          );

          // Sync in background - don't block the iterator
          syncSessionFile(
            remoteOptions.executor,
            projectDir,
            sessionId,
            undefined,
            remoteOptions.remoteEnv?.CLAUDE_SESSIONS_DIR,
          ).catch((error) => {
            log.warn(
              {
                event: "remote_session_sync_error",
                executor: remoteOptions.executor,
                sessionId,
                error: error instanceof Error ? error.message : String(error),
              },
              `Failed to sync session from remote: ${error}`,
            );
          });
        }
      }
    } catch (error) {
      // Handle abort errors gracefully
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      // Re-throw process termination errors for Process to handle
      // These include: "ProcessTransport is not ready for writing"
      throw error;
    }
  }

  /**
   * Convert an SDK message to our internal SDKMessage format.
   *
   * We pass through all fields from the SDK without stripping.
   * This preserves debugging info, DAG structure, and metadata.
   */
  private convertMessage(message: AgentSDKMessage): SDKMessage {
    // Pass through all fields, only normalize content blocks
    const sdkMessage = message as unknown as SDKMessage;

    // For messages with content, normalize the content blocks
    if (sdkMessage.message?.content) {
      return {
        ...sdkMessage,
        message: {
          ...sdkMessage.message,
          content: this.normalizeContent(sdkMessage.message.content),
        },
      };
    }

    // Pass through as-is for messages without content
    return sdkMessage;
  }

  /**
   * Normalize content to ensure consistent format.
   * Preserves all fields, only converts strings to text blocks.
   */
  private normalizeContent(
    content: string | ContentBlock[] | unknown,
  ): string | ContentBlock[] {
    // String content stays as string
    if (typeof content === "string") {
      return content;
    }

    // Array content - normalize each block
    if (Array.isArray(content)) {
      return content.map((block): ContentBlock => {
        if (typeof block === "string") {
          return { type: "text", text: block };
        }
        // Pass through all block fields - don't strip anything
        return block as ContentBlock;
      });
    }

    // Unknown content type - stringify for safety
    return String(content);
  }
}

/**
 * Default Claude provider instance.
 * Can be imported for convenience or instantiated directly.
 */
export const claudeProvider = new ClaudeProvider();
