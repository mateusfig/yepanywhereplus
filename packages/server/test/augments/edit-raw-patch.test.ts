import { describe, expect, it } from "vitest";
import {
  extractRawPatchFromEditInput,
  parseRawEditPatch,
} from "../../src/augments/edit-raw-patch.js";

describe("parseRawEditPatch", () => {
  it("parses a valid Codex apply_patch block into structured hunks", () => {
    const rawPatch = [
      "*** Begin Patch",
      "*** Update File: src/example.ts",
      "@@",
      " const x = 1;",
      "-const y = 1;",
      "+const y = 2;",
      "*** End Patch",
      "",
    ].join("\n");

    const parsed = parseRawEditPatch(rawPatch);

    expect(parsed).not.toBeNull();
    expect(parsed?.filePath).toBe("src/example.ts");
    expect(parsed?.structuredPatch).toHaveLength(1);
    expect(parsed?.structuredPatch[0]?.lines).toEqual([
      " const x = 1;",
      "-const y = 1;",
      "+const y = 2;",
    ]);
  });

  it("tolerates malformed patch text without throwing", () => {
    const rawPatch = [
      "*** Begin Patch",
      "*** Update File: src/example.ts",
      "this is not a hunk",
      "*** End Patch",
      "",
    ].join("\n");

    expect(() => parseRawEditPatch(rawPatch)).not.toThrow();
    const parsed = parseRawEditPatch(rawPatch);
    expect(parsed).not.toBeNull();
    expect(parsed?.structuredPatch).toEqual([]);
  });

  it("parses unified diff content without apply_patch markers", () => {
    const rawPatch = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,2 +1,2 @@",
      "-const x = 1;",
      "+const x = 2;",
      " const y = 3;",
      "",
    ].join("\n");

    const parsed = parseRawEditPatch(rawPatch);

    expect(parsed).not.toBeNull();
    expect(parsed?.filePath).toBe("src/example.ts");
    expect(parsed?.structuredPatch).toHaveLength(1);
    expect(parsed?.structuredPatch[0]?.oldStart).toBe(1);
    expect(parsed?.structuredPatch[0]?.newStart).toBe(1);
    expect(parsed?.structuredPatch[0]?.lines).toEqual([
      "-const x = 1;",
      "+const x = 2;",
      " const y = 3;",
    ]);
  });
});

describe("extractRawPatchFromEditInput", () => {
  it("extracts raw patch text from nested object shapes", () => {
    const rawPatch = "*** Begin Patch\n*** End Patch\n";
    const extracted = extractRawPatchFromEditInput({
      input: { patch: rawPatch },
    });
    expect(extracted).toBe(rawPatch);
  });

  it("extracts and combines diffs from codex file_change shapes", () => {
    const extracted = extractRawPatchFromEditInput({
      changes: [
        {
          path: "src/a.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-a\n+b\n",
        },
        {
          path: "src/b.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-c\n+d\n",
        },
      ],
    });

    expect(extracted).toContain("@@ -1 +1 @@");
    expect(extracted).toContain("-a");
    expect(extracted).toContain("+d");
  });
});
