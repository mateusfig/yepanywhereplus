import type {
  ClaudeSessionEntry,
  CodexSessionEntry,
  UnifiedSession,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { CodexProvider } from "../src/sdk/providers/codex.js";
import type { LoadedSession } from "../src/sessions/types.js";
import {
  assertRenderParity,
  normalizeRenderItemsForComparison,
  runPersistedPipeline,
  runStreamPipeline,
} from "./utils/render-parity-harness.ts";

type CodexProviderBridge = {
  convertItemToSDKMessages: (
    item: unknown,
    sessionId: string,
    turnId: string,
    isComplete: boolean,
  ) => Array<Record<string, unknown>>;
};

function buildLoadedCodexSession(entries: CodexSessionEntry[]): LoadedSession {
  return {
    summary: {
      id: "codex-render-parity",
      projectId: "test-project" as UrlProjectId,
      title: "Codex render parity",
      fullTitle: "Codex render parity",
      createdAt: "2026-03-05T12:00:00.000Z",
      updatedAt: "2026-03-05T12:00:10.000Z",
      messageCount: entries.length,
      status: "chat",
      provider: "codex",
    } as LoadedSession["summary"],
    data: {
      provider: "codex",
      events: [],
      session: { entries },
    } as UnifiedSession,
  };
}

function buildLoadedClaudeSession(
  messages: ClaudeSessionEntry[],
): LoadedSession {
  return {
    summary: {
      id: "claude-render-parity",
      projectId: "test-project" as UrlProjectId,
      title: "Claude render parity",
      fullTitle: "Claude render parity",
      createdAt: "2026-03-05T12:00:00.000Z",
      updatedAt: "2026-03-05T12:00:10.000Z",
      messageCount: messages.length,
      status: { state: "idle" },
      provider: "claude",
    } as LoadedSession["summary"],
    data: {
      provider: "claude",
      session: { messages },
    } as UnifiedSession,
  };
}

const EDIT_DIFF = [
  "diff --git a/src/readme.md b/src/readme.md",
  "--- a/src/readme.md",
  "+++ b/src/readme.md",
  "@@ -1,1 +1,1 @@",
  "-# Old heading",
  "+# New heading",
].join("\n");

function codexPersistedEntries(): CodexSessionEntry[] {
  return [
    {
      type: "response_item",
      timestamp: "2026-03-05T12:00:00.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Check tools and summarize." }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-03-05T12:00:01.000Z",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-read",
        arguments: '{"cmd":"cat src/readme.md"}',
      },
    },
    {
      type: "response_item",
      timestamp: "2026-03-05T12:00:02.000Z",
      payload: {
        type: "function_call_output",
        call_id: "call-read",
        output: "# Old heading\nsecond line\n",
      },
    },
    {
      type: "response_item",
      timestamp: "2026-03-05T12:00:03.000Z",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-grep",
        arguments: '{"command":"rg -n \\"needle\\" src -S"}',
      },
    },
    {
      type: "response_item",
      timestamp: "2026-03-05T12:00:04.000Z",
      payload: {
        type: "function_call_output",
        call_id: "call-grep",
        output:
          "Chunk ID: grep1\nWall time: 0.0100 seconds\nProcess exited with code 1\nOutput:\n\n",
      },
    },
    {
      type: "response_item",
      timestamp: "2026-03-05T12:00:05.000Z",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-bash",
        arguments: '{"command":"echo done"}',
      },
    },
    {
      type: "response_item",
      timestamp: "2026-03-05T12:00:06.000Z",
      payload: {
        type: "function_call_output",
        call_id: "call-bash",
        output: "done\n",
      },
    },
    {
      type: "response_item",
      timestamp: "2026-03-05T12:00:07.000Z",
      payload: {
        type: "custom_tool_call",
        call_id: "call-edit",
        name: "apply_patch",
        input: {
          file_path: "src/readme.md",
          changes: [{ path: "src/readme.md", kind: "update", diff: EDIT_DIFF }],
        },
      },
    },
    {
      type: "response_item",
      timestamp: "2026-03-05T12:00:08.000Z",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call-edit",
        output: "File changes applied:\nupdate: src/readme.md",
      },
    },
    {
      type: "response_item",
      timestamp: "2026-03-05T12:00:09.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Summary:\n\n```ts\nconst x = 1;\n```" },
        ],
      },
    },
  ];
}

function codexStreamMessages(): Array<Record<string, unknown>> {
  const provider = new CodexProvider() as unknown as CodexProviderBridge;
  const sessionId = "codex-render-parity-stream";
  const turnId = "turn-parity-1";

  const messages: Array<Record<string, unknown>> = [
    {
      type: "user",
      session_id: sessionId,
      uuid: "codex-user-1",
      message: { role: "user", content: "Check tools and summarize." },
    },
  ];

  const streamItems = [
    {
      id: "call-read",
      type: "command_execution",
      command: "cat src/readme.md",
      aggregated_output: "# Old heading\nsecond line\n",
      exit_code: 0,
      status: "completed",
    },
    {
      id: "call-grep",
      type: "command_execution",
      command: 'rg -n "needle" src -S',
      aggregated_output: "",
      exit_code: 1,
      status: "completed",
    },
    {
      id: "call-bash",
      type: "command_execution",
      command: "echo done",
      aggregated_output: "done\n",
      exit_code: 0,
      status: "completed",
    },
    {
      id: "call-edit",
      type: "file_change",
      status: "completed",
      changes: [{ path: "src/readme.md", kind: "update", diff: EDIT_DIFF }],
    },
    {
      id: "agent-final",
      type: "agent_message",
      text: "Summary:\n\n```ts\nconst x = 1;\n```",
    },
  ];

  for (const item of streamItems) {
    messages.push(
      ...provider.convertItemToSDKMessages(item, sessionId, turnId, true),
    );
  }

  return messages;
}

const CLAUDE_FIXTURE: ClaudeSessionEntry[] = [
  {
    type: "user",
    uuid: "claude-user-1",
    parentUuid: null,
    message: { role: "user", content: "Read /tmp/test.md and report." },
  },
  {
    type: "assistant",
    uuid: "claude-assistant-1",
    parentUuid: "claude-user-1",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I'll read it now." },
        {
          type: "tool_use",
          id: "claude-read-1",
          name: "Read",
          input: { file_path: "/tmp/test.md" },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "claude-user-2",
    parentUuid: "claude-assistant-1",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "claude-read-1",
          content: "# hello\nsecond line\n",
        },
      ],
    },
    toolUseResult: {
      type: "text",
      file: {
        filePath: "/tmp/test.md",
        content: "# hello\nsecond line\n",
        numLines: 2,
        startLine: 1,
        totalLines: 2,
      },
    },
  },
  {
    type: "assistant",
    uuid: "claude-assistant-2",
    parentUuid: "claude-user-2",
    message: {
      role: "assistant",
      content: "Done.\n\n```md\n# hello\n```",
    },
  },
];

describe("Render Parity Harness", () => {
  it("keeps Codex stream and persisted rendering equivalent", async () => {
    const persisted = await runPersistedPipeline(
      buildLoadedCodexSession(codexPersistedEntries()),
    );
    const stream = await runStreamPipeline(codexStreamMessages());

    assertRenderParity("codex", persisted.renderItems, stream.renderItems);

    const comparable = normalizeRenderItemsForComparison(
      persisted.renderItems,
    ) as Array<Record<string, unknown>>;
    const toolCalls = comparable.filter(
      (item) => item.type === "tool_call",
    ) as Array<Record<string, unknown>>;

    expect(toolCalls.map((call) => call.toolName)).toEqual([
      "Read",
      "Grep",
      "Bash",
      "Edit",
    ]);
    expect(toolCalls[0]?.toolResult).toMatchObject({
      isError: false,
      structured: {
        type: "text",
        file: {
          filePath: "src/readme.md",
        },
      },
    });
    expect(toolCalls[1]?.toolResult).toMatchObject({
      isError: false,
      structured: { mode: "files_with_matches", numFiles: 0 },
    });
    expect(
      comparable.some(
        (item) => item.type === "text" && item.hasAugmentHtml === true,
      ),
    ).toBe(true);
  });

  it("keeps Claude stream and persisted rendering equivalent", async () => {
    const persisted = await runPersistedPipeline(
      buildLoadedClaudeSession(CLAUDE_FIXTURE),
    );
    const stream = await runStreamPipeline(
      CLAUDE_FIXTURE as unknown as Array<Record<string, unknown>>,
    );

    assertRenderParity("claude", persisted.renderItems, stream.renderItems);

    const comparable = normalizeRenderItemsForComparison(
      persisted.renderItems,
    ) as Array<Record<string, unknown>>;
    const readCall = comparable.find(
      (item) =>
        item.type === "tool_call" &&
        item.toolName === "Read" &&
        item.status === "complete",
    ) as Record<string, unknown> | undefined;

    expect(readCall).toBeDefined();
    expect(readCall?.toolResult).toMatchObject({
      isError: false,
      structured: {
        type: "text",
        file: {
          filePath: "/tmp/test.md",
          numLines: 2,
        },
      },
    });
    expect(
      comparable.some(
        (item) => item.type === "text" && item.hasAugmentHtml === true,
      ),
    ).toBe(true);
  });
});
