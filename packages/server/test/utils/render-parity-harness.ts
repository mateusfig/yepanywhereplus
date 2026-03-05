import { inspect } from "node:util";
import {
  type PreprocessAugments,
  preprocessMessages,
} from "../../../client/src/lib/preprocessMessages.ts";
import type { Message as ClientMessage } from "../../../client/src/types.ts";
import type { RenderItem } from "../../../client/src/types/renderItems.ts";
import { createStreamAugmenter } from "../../src/augments/stream-augmenter.js";
import { normalizeSession } from "../../src/sessions/normalization.js";
import { augmentPersistedSessionMessages } from "../../src/sessions/persisted-augments.js";
import type { LoadedSession } from "../../src/sessions/types.js";
import { normalizeStreamMessage } from "../../src/subscriptions.js";
import type { Message as ServerMessage } from "../../src/supervisor/types.js";

export interface PersistedPipelineResult {
  messages: ClientMessage[];
  renderItems: RenderItem[];
}

export interface StreamPipelineResult {
  messages: ClientMessage[];
  renderItems: RenderItem[];
}

const NON_SEMANTIC_KEYS = new Set([
  "id",
  "uuid",
  "timestamp",
  "session_id",
  "sessionId",
  "_source",
  "parentUuid",
  "parent_tool_use_id",
  "parentToolUseId",
]);

const HTML_PRESENCE_KEYS = new Set([
  "_diffHtml",
  "_highlightedContentHtml",
  "_renderedMarkdownHtml",
  "_renderedHtml",
]);

function normalizeHtml(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeUnknown(item));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (NON_SEMANTIC_KEYS.has(key)) continue;
      const nested = record[key];
      if (nested === undefined) continue;

      if (HTML_PRESENCE_KEYS.has(key)) {
        out[key] = typeof nested === "string" && nested.trim().length > 0;
        continue;
      }

      out[key] = normalizeUnknown(nested);
    }
    return out;
  }
  return value;
}

function normalizeUserPromptContent(content: unknown): unknown {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: string }).type === "text" &&
          typeof (block as { text?: string }).text === "string"
        ) {
          return (block as { text: string }).text;
        }
        return null;
      })
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    if (text.length > 0) {
      return text;
    }
  }
  return normalizeUnknown(content);
}

export function normalizeRenderItemsForComparison(
  items: RenderItem[],
): unknown[] {
  return items.map((item) => {
    if (item.type === "tool_call") {
      return {
        type: item.type,
        status: item.status,
        toolName: item.toolName,
        toolInput: normalizeUnknown(item.toolInput),
        toolResult: item.toolResult
          ? {
              content: item.toolResult.content,
              isError: item.toolResult.isError,
              structured: normalizeUnknown(item.toolResult.structured),
            }
          : null,
      };
    }

    if (item.type === "text") {
      return {
        type: item.type,
        text: item.text,
        isStreaming: item.isStreaming ?? false,
        hasAugmentHtml: Boolean(item.augmentHtml),
        augmentHtml: normalizeHtml(item.augmentHtml),
      };
    }

    if (item.type === "thinking") {
      return {
        type: item.type,
        thinking: item.thinking,
        status: item.status,
      };
    }

    if (item.type === "user_prompt") {
      return {
        type: item.type,
        content: normalizeUserPromptContent(item.content),
      };
    }

    if (item.type === "session_setup") {
      return {
        type: item.type,
        title: item.title,
        prompts: normalizeUnknown(item.prompts),
      };
    }

    return {
      type: item.type,
      subtype: item.subtype,
      content: item.content,
      status: item.status ?? null,
    };
  });
}

function findFirstDifference(
  left: unknown,
  right: unknown,
  path = "$",
): { path: string; left: unknown; right: unknown } | null {
  if (Object.is(left, right)) return null;

  if (typeof left !== typeof right) {
    return { path, left, right };
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return { path: `${path}.length`, left: left.length, right: right.length };
    }
    for (let i = 0; i < left.length; i++) {
      const diff = findFirstDifference(left[i], right[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }

  if (
    left &&
    right &&
    typeof left === "object" &&
    typeof right === "object" &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = new Set([
      ...Object.keys(leftRecord),
      ...Object.keys(rightRecord),
    ]);

    for (const key of [...keys].sort()) {
      if (!(key in leftRecord)) {
        return {
          path: `${path}.${key}`,
          left: undefined,
          right: rightRecord[key],
        };
      }
      if (!(key in rightRecord)) {
        return {
          path: `${path}.${key}`,
          left: leftRecord[key],
          right: undefined,
        };
      }
      const diff = findFirstDifference(
        leftRecord[key],
        rightRecord[key],
        `${path}.${key}`,
      );
      if (diff) return diff;
    }
    return null;
  }

  return { path, left, right };
}

function mergePreprocessAugments(
  base: PreprocessAugments | undefined,
  markdown: Record<string, { html: string }>,
): PreprocessAugments | undefined {
  if (Object.keys(markdown).length === 0) {
    return base;
  }
  return {
    ...(base ?? {}),
    markdown: {
      ...(base?.markdown ?? {}),
      ...markdown,
    },
  };
}

export async function runPersistedPipeline(
  loadedSession: LoadedSession,
  preprocessAugments?: PreprocessAugments,
): Promise<PersistedPipelineResult> {
  const normalizedSession = normalizeSession(
    structuredClone(loadedSession),
  ) as { messages: ClientMessage[] };
  await augmentPersistedSessionMessages(
    normalizedSession.messages as unknown as ServerMessage[],
  );
  const renderItems = preprocessMessages(
    normalizedSession.messages,
    preprocessAugments,
  );
  return {
    messages: normalizedSession.messages,
    renderItems,
  };
}

export async function runStreamPipeline(
  streamMessages: Array<Record<string, unknown>>,
  preprocessAugments?: PreprocessAugments,
): Promise<StreamPipelineResult> {
  const markdownAugments: Record<string, { html: string }> = {};
  const collectedMessages: ClientMessage[] = [];

  const augmenter = await createStreamAugmenter({
    onMarkdownAugment: (data) => {
      if (
        data.messageId &&
        data.blockIndex === undefined &&
        typeof data.html === "string"
      ) {
        markdownAugments[data.messageId] = { html: data.html };
      }
    },
    onPending: () => {},
  });

  for (const rawMessage of streamMessages) {
    const message = structuredClone(rawMessage);
    normalizeStreamMessage(message);
    await augmenter.processMessage(message);

    const type = message.type;
    if (
      type === "assistant" ||
      type === "user" ||
      type === "system" ||
      type === "error" ||
      type === "summary"
    ) {
      collectedMessages.push(message as unknown as ClientMessage);
    }
  }

  await augmenter.flush();

  const renderItems = preprocessMessages(
    collectedMessages,
    mergePreprocessAugments(preprocessAugments, markdownAugments),
  );

  return {
    messages: collectedMessages,
    renderItems,
  };
}

export function assertRenderParity(
  fixtureName: string,
  persistedItems: RenderItem[],
  streamItems: RenderItem[],
): void {
  const persistedComparable = normalizeRenderItemsForComparison(persistedItems);
  const streamComparable = normalizeRenderItemsForComparison(streamItems);
  const diff = findFirstDifference(persistedComparable, streamComparable);

  if (!diff) return;

  throw new Error(
    [
      `[${fixtureName}] Render parity drift at ${diff.path}`,
      `Persisted: ${inspect(diff.left, { depth: 8, breakLength: 120 })}`,
      `Stream: ${inspect(diff.right, { depth: 8, breakLength: 120 })}`,
      "Persisted normalized render items:",
      JSON.stringify(persistedComparable, null, 2),
      "Stream normalized render items:",
      JSON.stringify(streamComparable, null, 2),
    ].join("\n"),
  );
}
