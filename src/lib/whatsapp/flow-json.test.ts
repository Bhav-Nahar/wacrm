import { describe, expect, it } from "vitest";
import {
  buildFlowJson,
  formFieldsSignature,
  validateFormFields,
  FLOW_JSON_VERSION,
  GENERATED_SCREEN_ID,
  type FormField,
} from "./flow-json";

const FIELDS: FormField[] = [
  { name: "full_name", label: "Your name", type: "text", required: true },
  { name: "email", label: "Email", type: "email", required: true },
  { name: "budget", label: "Budget", type: "dropdown", options: ["<50k", "50k-100k"] },
];

/** The Form component's children, which is where the inputs live. */
function formChildren(json: Record<string, unknown>) {
  const screens = json.screens as Record<string, unknown>[];
  const layout = screens[0].layout as { children: Record<string, unknown>[] };
  const form = layout.children[0] as { children: Record<string, unknown>[] };
  return form.children;
}

function footer(json: Record<string, unknown>) {
  const kids = formChildren(json);
  return kids[kids.length - 1] as {
    type: string;
    label: string;
    "on-click-action": { name: string; payload: Record<string, string> };
  };
}

describe("buildFlowJson", () => {
  it("emits one terminal screen with the fixed generated id", () => {
    const json = buildFlowJson({ fields: FIELDS });
    expect(json.version).toBe(FLOW_JSON_VERSION);
    const screens = json.screens as Record<string, unknown>[];
    expect(screens).toHaveLength(1);
    expect(screens[0].id).toBe(GENERATED_SCREEN_ID);
    // Terminal is what hands control back to our runner on submit.
    expect(screens[0].terminal).toBe(true);
  });

  it("maps each field type to the right Meta component", () => {
    const json = buildFlowJson({
      fields: [
        { name: "a", label: "A", type: "text" },
        { name: "b", label: "B", type: "email" },
        { name: "c", label: "C", type: "number" },
        { name: "d", label: "D", type: "phone" },
        { name: "e", label: "E", type: "textarea" },
        { name: "f", label: "F", type: "date" },
        { name: "g", label: "G", type: "dropdown", options: ["x"] },
      ],
    });
    const kids = formChildren(json).slice(0, 7) as {
      type: string;
      "input-type"?: string;
    }[];
    expect(kids.map((k) => k.type)).toEqual([
      "TextInput",
      "TextInput",
      "TextInput",
      "TextInput",
      "TextArea",
      "DatePicker",
      "Dropdown",
    ]);
    // The four TextInputs differ only by input-type.
    expect(kids.slice(0, 4).map((k) => k["input-type"])).toEqual([
      "text",
      "email",
      "number",
      "phone",
    ]);
  });

  it("uses the visible option text as the option id", () => {
    // So flow_runs.vars reads "50k-100k", not "opt_2" — these values
    // get interpolated into agent-facing handoff notes.
    const json = buildFlowJson({ fields: FIELDS });
    const dd = formChildren(json)[2] as {
      "data-source": { id: string; title: string }[];
    };
    expect(dd["data-source"]).toEqual([
      { id: "<50k", title: "<50k" },
      { id: "50k-100k", title: "50k-100k" },
    ]);
  });

  it("drops blank dropdown options", () => {
    const json = buildFlowJson({
      fields: [{ name: "x", label: "X", type: "dropdown", options: ["a", "  ", ""] }],
    });
    const dd = formChildren(json)[0] as { "data-source": unknown[] };
    expect(dd["data-source"]).toHaveLength(1);
  });

  it("marks only the required fields required", () => {
    const json = buildFlowJson({ fields: FIELDS });
    const kids = formChildren(json).slice(0, 3) as { required?: boolean }[];
    expect(kids.map((k) => k.required)).toEqual([true, true, undefined]);
  });

  it("references EVERY field in the footer's complete payload", () => {
    // The payload is what decides which answers come back in
    // nfm_reply.response_json. A field missing here is filled in by the
    // customer and then silently lost.
    const f = footer(buildFlowJson({ fields: FIELDS }));
    expect(f.type).toBe("Footer");
    expect(f["on-click-action"].name).toBe("complete");
    expect(f["on-click-action"].payload).toEqual({
      full_name: "${form.full_name}",
      email: "${form.email}",
      budget: "${form.budget}",
    });
  });

  it("honours a custom submit label and title", () => {
    const json = buildFlowJson({
      fields: FIELDS,
      submitLabel: "Get my quote",
      title: "Quick quote",
    });
    expect(footer(json).label).toBe("Get my quote");
    expect((json.screens as Record<string, unknown>[])[0].title).toBe(
      "Quick quote",
    );
  });

  it("omits title when not given, rather than emitting an empty one", () => {
    const json = buildFlowJson({ fields: FIELDS });
    expect((json.screens as Record<string, unknown>[])[0].title).toBeUndefined();
  });

  it("produces JSON that survives a round trip through a string", () => {
    // It is sent to Meta as a string parameter, so it must serialise.
    const json = buildFlowJson({ fields: FIELDS });
    expect(() => JSON.parse(JSON.stringify(json))).not.toThrow();
    // The ${form.x} references must survive verbatim — they are Meta's
    // template syntax, not ours, and must not be interpolated by us.
    expect(JSON.stringify(json)).toContain("${form.email}");
  });
});

describe("validateFormFields", () => {
  it("accepts a well-formed field list", () => {
    expect(validateFormFields(FIELDS)).toEqual({ ok: true });
  });

  it("rejects an empty form", () => {
    const r = validateFormFields([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/at least one field/);
  });

  it("rejects a field name that would break {{vars.x}} interpolation", () => {
    const r = validateFormFields([
      { name: "full name", label: "Name", type: "text" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/full name/);
  });

  it("rejects duplicate field names", () => {
    const r = validateFormFields([
      { name: "email", label: "A", type: "text" },
      { name: "email", label: "B", type: "text" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/Duplicate field name/);
  });

  it("rejects a dropdown with no options", () => {
    const r = validateFormFields([
      { name: "b", label: "B", type: "dropdown", options: [] },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/at least one option/);
  });

  it("rejects duplicate dropdown options", () => {
    const r = validateFormFields([
      { name: "b", label: "B", type: "dropdown", options: ["x", "x"] },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/duplicate options/);
  });

  it("rejects a submit label past Meta's 35-char footer limit", () => {
    const r = validateFormFields(FIELDS, "x".repeat(36));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/35-character/);
  });

  it("rejects a form longer than one screen can carry", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      name: `f${i}`,
      label: `F${i}`,
      type: "text" as const,
    }));
    const r = validateFormFields(many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/at most 12 fields/);
  });

  it("requires a label on every field", () => {
    const r = validateFormFields([{ name: "a", label: "  ", type: "text" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/needs a label/);
  });
});

describe("formFieldsSignature", () => {
  it("is stable across identical field lists", () => {
    expect(formFieldsSignature(FIELDS)).toBe(formFieldsSignature(FIELDS));
  });

  it("changes when a label changes", () => {
    const edited = FIELDS.map((f) =>
      f.name === "email" ? { ...f, label: "Work email" } : f,
    );
    expect(formFieldsSignature(edited)).not.toBe(formFieldsSignature(FIELDS));
  });

  it("changes when a dropdown's options change", () => {
    const edited = FIELDS.map((f) =>
      f.name === "budget" ? { ...f, options: ["<50k"] } : f,
    );
    expect(formFieldsSignature(edited)).not.toBe(formFieldsSignature(FIELDS));
  });

  it("changes when the submit label changes", () => {
    expect(formFieldsSignature(FIELDS, "Send")).not.toBe(
      formFieldsSignature(FIELDS, "Submit"),
    );
  });

  it("ignores dropdown options on non-dropdown fields", () => {
    // Stray options on a text field must not force a needless republish
    // — a published Flow can only be replaced, never edited.
    const a: FormField[] = [{ name: "x", label: "X", type: "text" }];
    const b: FormField[] = [
      { name: "x", label: "X", type: "text", options: ["ignored"] },
    ];
    expect(formFieldsSignature(a)).toBe(formFieldsSignature(b));
  });

  it("treats required:false and omitted as the same", () => {
    const a: FormField[] = [{ name: "x", label: "X", type: "text" }];
    const b: FormField[] = [
      { name: "x", label: "X", type: "text", required: false },
    ];
    expect(formFieldsSignature(a)).toBe(formFieldsSignature(b));
  });
});
