/**
 * Build Meta Flow JSON from a plain list of fields.
 *
 * This is what lets a wacrm user author a WhatsApp form without ever
 * opening Meta's Flow Builder: they name their fields, we emit the
 * JSON, and `createFlow` + `publishFlow` do the rest.
 *
 * Scope is deliberately one screen. A single-screen form covers the
 * "collect customer info in one interaction" case the feature exists
 * for, and it keeps the generated JSON small enough to reason about.
 * Multi-screen means branching, per-screen navigation actions, and a
 * back-stack — none of which a field list can express.
 *
 * ponytail: single screen, no conditional visibility, no data_exchange
 * endpoint. Add screens when a customer actually needs a form longer
 * than one phone-height page.
 */

/** The screen id we emit. Fixed, because we generate it — so no user
 *  ever has to find or type a screen id. */
export const GENERATED_SCREEN_ID = "FORM";

/** The Form component's name; field values arrive under these keys. */
const FORM_NAME = "form";

/**
 * Flow JSON version we target.
 *
 * 5.1 is the newest version Meta's Flow JSON reference documents, and
 * everything emitted here (TextInput/Dropdown/DatePicker/TextArea +
 * a `complete` footer action) exists well before it. Bump only
 * alongside a feature that needs a newer component — a version string
 * Meta does not recognise fails the whole create call.
 */
export const FLOW_JSON_VERSION = "5.1";

export type FormFieldType =
  | "text"
  | "email"
  | "number"
  | "phone"
  | "textarea"
  | "dropdown"
  | "date";

export interface FormField {
  /**
   * Key the answer arrives under. Becomes a `flow_runs.vars` key (with
   * the node's prefix), so it has to survive `{{vars.x}}` interpolation.
   */
  name: string;
  /** What the customer reads above the input. */
  label: string;
  type: FormFieldType;
  required?: boolean;
  /** dropdown only — the choices. Ignored by every other type. */
  options?: string[];
  /** Small grey hint under the input. Not supported on dropdown/date. */
  helper_text?: string;
}

export type FlowJsonValidation =
  | { ok: true }
  | { ok: false; errors: string[] };

/** Meta caps a Footer label at 35 chars. */
const FOOTER_LABEL_MAX = 35;
/** Our own ceiling — a phone-height single screen stops being usable. */
const MAX_FIELDS = 12;

/**
 * Check a field list before we spend a network call on it.
 *
 * Meta validates too, but its errors arrive as a rejected create and
 * read like schema complaints. Catching the predictable problems here
 * means the builder can point at the offending field instead.
 */
export function validateFormFields(
  fields: FormField[],
  submitLabel = "Submit",
): FlowJsonValidation {
  const errors: string[] = [];

  if (!Array.isArray(fields) || fields.length === 0) {
    errors.push("Add at least one field to the form.");
  }
  if (fields.length > MAX_FIELDS) {
    errors.push(
      `A form allows at most ${MAX_FIELDS} fields (got ${fields.length}).`,
    );
  }
  if (submitLabel.length > FOOTER_LABEL_MAX) {
    errors.push(
      `Submit button label exceeds Meta's ${FOOTER_LABEL_MAX}-character limit.`,
    );
  }

  const seen = new Set<string>();
  for (const f of fields) {
    if (!f?.name?.trim()) {
      errors.push("Every field needs a name.");
      continue;
    }
    // The name becomes a vars key, and interpolation only matches
    // [a-zA-Z0-9_] after a letter/underscore.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(f.name)) {
      errors.push(
        `Field name "${f.name}" must be letters, numbers and underscores, starting with a letter or underscore.`,
      );
    }
    if (seen.has(f.name)) {
      errors.push(`Duplicate field name "${f.name}".`);
    }
    seen.add(f.name);

    if (!f.label?.trim()) {
      errors.push(`Field "${f.name}" needs a label.`);
    }
    if (f.type === "dropdown") {
      const opts = (f.options ?? []).filter((o) => o?.trim());
      if (opts.length < 1) {
        errors.push(`Dropdown "${f.name}" needs at least one option.`);
      }
      if (new Set(opts).size !== opts.length) {
        errors.push(`Dropdown "${f.name}" has duplicate options.`);
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** TextInput's `input-type`, for the types that map onto it. */
const TEXT_INPUT_TYPE: Partial<Record<FormFieldType, string>> = {
  text: "text",
  email: "email",
  number: "number",
  phone: "phone",
};

function component(field: FormField): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: field.name,
    label: field.label,
  };
  if (field.required) base.required = true;

  switch (field.type) {
    case "dropdown":
      return {
        type: "Dropdown",
        ...base,
        // Option ids are the values we receive. Using the visible text
        // as the id keeps flow_runs.vars readable — "50k-100k" rather
        // than "opt_2" — which matters because these values end up
        // interpolated into agent-facing handoff notes.
        "data-source": (field.options ?? [])
          .filter((o) => o?.trim())
          .map((o) => ({ id: o, title: o })),
      };

    case "date":
      return { type: "DatePicker", ...base };

    case "textarea":
      return {
        type: "TextArea",
        ...base,
        ...(field.helper_text ? { "helper-text": field.helper_text } : {}),
      };

    default:
      return {
        type: "TextInput",
        ...base,
        "input-type": TEXT_INPUT_TYPE[field.type] ?? "text",
        ...(field.helper_text ? { "helper-text": field.helper_text } : {}),
      };
  }
}

export interface BuildFlowJsonArgs {
  fields: FormField[];
  /** Footer button label. Meta caps it at 35 chars. */
  submitLabel?: string;
  /** Optional heading above the inputs. */
  title?: string;
}

/**
 * Emit the Flow JSON for a one-screen form.
 *
 * The Footer's `complete` action payload is what decides the keys we
 * get back in `nfm_reply.response_json` — each entry maps a field's
 * name to its `${form.<name>}` reference. Miss a field here and its
 * answer never reaches us, even though the customer filled it in.
 */
export function buildFlowJson(args: BuildFlowJsonArgs): Record<string, unknown> {
  const { fields, submitLabel = "Submit", title } = args;

  const payload: Record<string, string> = {};
  for (const f of fields) {
    payload[f.name] = `\${form.${f.name}}`;
  }

  const children: Record<string, unknown>[] = [
    {
      type: "Form",
      name: FORM_NAME,
      children: [
        ...fields.map(component),
        {
          type: "Footer",
          label: submitLabel,
          "on-click-action": { name: "complete", payload },
        },
      ],
    },
  ];

  const screen: Record<string, unknown> = {
    id: GENERATED_SCREEN_ID,
    // Terminal because there is exactly one screen — submitting it ends
    // the Flow and hands control back to our runner.
    terminal: true,
    layout: { type: "SingleColumnLayout", children },
  };
  if (title) screen.title = title;

  return { version: FLOW_JSON_VERSION, screens: [screen] };
}

/**
 * Stable signature of a field list.
 *
 * A published Flow is immutable — Meta allows deprecate, never edit. So
 * "the user changed their form" has to mean "create and publish a new
 * Flow, repoint the node, deprecate the old one". Comparing this
 * signature against the one stored on the node is how we know whether
 * that expensive round trip is actually needed, instead of minting a
 * new Flow on every save.
 */
export function formFieldsSignature(
  fields: FormField[],
  submitLabel = "Submit",
  title?: string,
): string {
  const normalized = fields.map((f) => ({
    name: f.name,
    label: f.label,
    type: f.type,
    required: Boolean(f.required),
    options: f.type === "dropdown" ? (f.options ?? []) : [],
    helper_text: f.helper_text ?? "",
  }));
  return JSON.stringify({
    v: FLOW_JSON_VERSION,
    submitLabel,
    title: title ?? "",
    fields: normalized,
  });
}
