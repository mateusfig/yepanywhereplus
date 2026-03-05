import {
  extractRawPatchFromEditInput,
  parseRawEditPatch,
} from "../augments/edit-raw-patch.js";
import {
  type EditInputWithAugment,
  type ExitPlanModeInput,
  type ExitPlanModeResult,
  type ReadResultWithAugment,
  type WriteInputWithAugment,
  computeEditAugment,
  computeReadAugment,
  computeStructuredPatchDiffHtml,
  computeWriteAugment,
} from "../augments/index.js";
import {
  augmentTextBlocks,
  renderMarkdownToHtml,
} from "../augments/markdown-augments.js";
import type { Message } from "../supervisor/types.js";

/**
 * Embed Edit augment data directly into tool_use inputs.
 * Adds _structuredPatch and _diffHtml to Edit tool_use input blocks.
 */
export async function augmentEditToolUses(messages: Message[]): Promise<void> {
  const promises: Promise<void>[] = [];

  for (const msg of messages) {
    if (msg.type !== "assistant") continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (
        block.type === "tool_use" &&
        block.name === "Edit" &&
        block.id &&
        block.input
      ) {
        const rawInput = block.input;
        const input =
          typeof rawInput === "object" &&
          rawInput !== null &&
          !Array.isArray(rawInput)
            ? (rawInput as EditInputWithAugment)
            : undefined;

        if (
          input?.file_path &&
          typeof input.old_string === "string" &&
          typeof input.new_string === "string" &&
          !input._structuredPatch
        ) {
          const toolUseId = block.id;
          promises.push(
            computeEditAugment(toolUseId, {
              file_path: input.file_path,
              old_string: input.old_string,
              new_string: input.new_string,
            })
              .then((augment) => {
                input._structuredPatch = augment.structuredPatch;
                input._diffHtml = augment.diffHtml;
              })
              .catch(() => {
                // Augments are best-effort.
              }),
          );
          continue;
        }

        const rawPatch = extractRawPatchFromEditInput(rawInput);
        if (!rawPatch) {
          continue;
        }

        const targetInput =
          input ??
          ({
            file_path: "",
            old_string: "",
            new_string: "",
          } as EditInputWithAugment);

        if (!input) {
          block.input = targetInput;
        }

        if (!targetInput._rawPatch) {
          targetInput._rawPatch = rawPatch;
        }

        const parsedPatch = parseRawEditPatch(rawPatch);
        if (!parsedPatch) {
          continue;
        }

        if (!targetInput.file_path && parsedPatch.filePath) {
          targetInput.file_path = parsedPatch.filePath;
        }

        if (
          !targetInput._structuredPatch &&
          parsedPatch.structuredPatch.length > 0
        ) {
          targetInput._structuredPatch = parsedPatch.structuredPatch;
        }

        if (
          !targetInput._diffHtml &&
          targetInput._structuredPatch &&
          targetInput._structuredPatch.length > 0
        ) {
          const patchHunks = targetInput._structuredPatch;
          const filePathForHighlight =
            targetInput.file_path || parsedPatch.filePath || "";

          promises.push(
            computeStructuredPatchDiffHtml(filePathForHighlight, patchHunks)
              .then((diffHtml) => {
                if (diffHtml) {
                  targetInput._diffHtml = diffHtml;
                }
              })
              .catch(() => {
                // Augments are best-effort.
              }),
          );
        }
      }
    }
  }

  await Promise.all(promises);
}

/**
 * Embed Write augment data directly into tool_use inputs.
 * Adds syntax-highlighted fields to Write tool_use input blocks.
 */
export async function augmentWriteToolUses(messages: Message[]): Promise<void> {
  const promises: Promise<void>[] = [];

  for (const msg of messages) {
    if (msg.type !== "assistant") continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === "tool_use" && block.name === "Write" && block.input) {
        const input = block.input as WriteInputWithAugment;
        if (
          typeof input.file_path === "string" &&
          typeof input.content === "string" &&
          !input._highlightedContentHtml
        ) {
          promises.push(
            computeWriteAugment({
              file_path: input.file_path,
              content: input.content,
            })
              .then((augment) => {
                if (augment) {
                  input._highlightedContentHtml = augment.highlightedHtml;
                  input._highlightedLanguage = augment.language;
                  input._highlightedTruncated = augment.truncated;
                  if (augment.renderedMarkdownHtml) {
                    input._renderedMarkdownHtml = augment.renderedMarkdownHtml;
                  }
                }
              })
              .catch(() => {
                // Augments are best-effort.
              }),
          );
        }
      }
    }
  }

  await Promise.all(promises);
}

/**
 * Render ExitPlanMode plan HTML and augment structured Read tool results.
 */
export async function augmentExitPlanModeAndReadResults(
  messages: Message[],
): Promise<void> {
  const promises: Promise<void>[] = [];

  for (const msg of messages) {
    if (msg.type === "assistant") {
      const content = msg.message?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (
          block.type === "tool_use" &&
          block.name === "ExitPlanMode" &&
          block.input
        ) {
          const input = block.input as ExitPlanModeInput;
          if (input.plan && !input._renderedHtml) {
            promises.push(
              renderMarkdownToHtml(input.plan)
                .then((html) => {
                  input._renderedHtml = html;
                })
                .catch(() => {
                  // Augments are best-effort.
                }),
            );
          }
        }
      }
    }

    if (msg.type === "user") {
      const toolUseResult = (msg as Record<string, unknown>).toolUseResult as
        | ExitPlanModeResult
        | undefined;
      const toolUseResultSnake = (msg as Record<string, unknown>)
        .tool_use_result as ExitPlanModeResult | undefined;
      const result = toolUseResult ?? toolUseResultSnake;

      if (result?.plan && !result._renderedHtml) {
        promises.push(
          renderMarkdownToHtml(result.plan)
            .then((html) => {
              result._renderedHtml = html;
            })
            .catch(() => {
              // Augments are best-effort.
            }),
        );
      }

      const readResult = (toolUseResult ?? toolUseResultSnake) as
        | ReadResultWithAugment
        | undefined;
      if (
        readResult?.type === "text" &&
        readResult.file?.filePath &&
        readResult.file?.content &&
        !readResult._highlightedContentHtml
      ) {
        promises.push(
          computeReadAugment({
            file_path: readResult.file.filePath,
            content: readResult.file.content,
          })
            .then((augment) => {
              if (augment) {
                readResult._highlightedContentHtml = augment.highlightedHtml;
                readResult._highlightedLanguage = augment.language;
                readResult._highlightedTruncated = augment.truncated;
                if (augment.renderedMarkdownHtml) {
                  readResult._renderedMarkdownHtml =
                    augment.renderedMarkdownHtml;
                }
              }
            })
            .catch(() => {
              // Augments are best-effort.
            }),
        );
      }
    }
  }

  await Promise.all(promises);
}

/**
 * Apply the same persisted-message augmentation pipeline used by session GET.
 */
export async function augmentPersistedSessionMessages(
  messages: Message[],
): Promise<void> {
  await augmentEditToolUses(messages);
  await augmentWriteToolUses(messages);
  await augmentTextBlocks(messages);
  await augmentExitPlanModeAndReadResults(messages);
}
