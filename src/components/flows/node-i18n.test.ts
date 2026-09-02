import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NODE_META, type NodeType } from "./shared";

// ============================================================
// Every node type must have i18n label + blurb in every locale.
//
// `send_form` shipped without them. NODE_META carried a label, which
// made it look done — but the builder renders `t('nodes.<type>.label')`
// from the locale files, not from NODE_META, across eight call sites
// (the add-node dropdowns in the list view, the canvas, and the editor
// shell, plus the node cards). The result was a node sitting in the
// palette that the user could not identify, which reads as "the
// feature isn't there".
//
// Typecheck can't catch this: the key is built by template string, so
// a missing entry is a runtime lookup failure, not a type error.
// ============================================================

const LOCALES = ["en", "ko"] as const;

function nodeMessages(locale: string): Record<string, unknown> {
  const raw = readFileSync(`messages/${locale}.json`, "utf8");
  const parsed = JSON.parse(raw) as {
    Flows: { builder: { nodes: Record<string, unknown> } };
  };
  return parsed.Flows.builder.nodes;
}

const NODE_TYPES = Object.keys(NODE_META) as NodeType[];

describe("flow node i18n coverage", () => {
  it("knows about every node type (guards the fixture itself)", () => {
    // If NODE_META is ever emptied or renamed, the per-locale loops
    // below would vacuously pass.
    expect(NODE_TYPES.length).toBeGreaterThanOrEqual(11);
    expect(NODE_TYPES).toContain("send_form");
  });

  for (const locale of LOCALES) {
    describe(locale, () => {
      it("has a label and blurb for every node type", () => {
        const messages = nodeMessages(locale);
        const missing: string[] = [];
        for (const type of NODE_TYPES) {
          const entry = messages[type] as
            | { label?: unknown; blurb?: unknown }
            | undefined;
          if (!entry) {
            missing.push(`${type} (absent)`);
            continue;
          }
          if (typeof entry.label !== "string" || entry.label.trim() === "") {
            missing.push(`${type}.label`);
          }
          if (typeof entry.blurb !== "string" || entry.blurb.trim() === "") {
            missing.push(`${type}.blurb`);
          }
        }
        expect(missing).toEqual([]);
      });

      it("has no entries for node types that no longer exist", () => {
        const stale = Object.keys(nodeMessages(locale)).filter(
          (k) => !(NODE_TYPES as string[]).includes(k),
        );
        expect(stale).toEqual([]);
      });
    });
  }
});
