import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Reviving a run when the customer taps a stale prompt.
//
// The scenario, from the FiberBlade flow in production: the material
// list offers five metals plus Glass. Glass declines and walks to an
// `end` node, so the run completes. The list message is still sitting
// in the customer's chat, so they tap "Aluminium" — and nothing
// happened, because the active-run lookup found none and a row title
// never matches a greeting-keyword entry trigger.
//
// Needs its own Supabase fake rather than dispatch.test.ts's: that one
// returns the same flow_runs rows for every query, and these tests turn
// entirely on telling the active-run lookup (status = 'active') apart
// from the reopen lookup (status IN ('completed','timed_out')).
// ============================================================

interface Filters {
  eq: Record<string, unknown>;
  in: Record<string, unknown[]>;
}

const h = vi.hoisted(() => ({
  state: {
    activeRuns: [] as unknown[],
    endedRuns: [] as unknown[],
    flows: [] as unknown[],
    nodes: [] as unknown[],
    /** flow_runs UPDATEs, in order, with the filters they carried. */
    updates: [] as { patch: Record<string, unknown>; status?: unknown }[],
    /** Rows the guarded reopen UPDATE reports affecting. */
    updateAffects: 1,
    /** Set to simulate the partial-unique-index collision. */
    updateError: null as { code?: string; message: string } | null,
    /** Every flow_runs SELECT's status filter, to prove which ran. */
    runQueries: [] as Filters[],
    inserted: [] as { table: string; row: Record<string, unknown> }[],
  },
}));

vi.mock("./admin-client", () => {
  function builder(table: string) {
    const f: Filters = { eq: {}, in: {} };
    let mode: "select" | "update" = "select";
    let patch: Record<string, unknown> = {};

    function rows(): unknown[] {
      if (table === "flows") return h.state.flows;
      if (table === "flow_nodes") return h.state.nodes;
      if (table === "flow_runs") {
        h.state.runQueries.push({ eq: { ...f.eq }, in: { ...f.in } });
        // The reopen lookup is the one filtering status by a SET.
        if (f.in.status) return h.state.endedRuns;
        if (f.eq.status === "active") return h.state.activeRuns;
        return [];
      }
      return [];
    }

    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        f.eq[col] = val;
        return b;
      },
      in: (col: string, vals: unknown[]) => {
        f.in[col] = vals;
        return b;
      },
      gte: () => b,
      filter: () => b,
      order: () => b,
      limit: () => b,
      update: (p: Record<string, unknown>) => {
        mode = "update";
        patch = p;
        return b;
      },
      insert: (row: Record<string, unknown>) => {
        h.state.inserted.push({ table, row });
        return b;
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (r: { data: unknown; error: unknown }) => unknown) => {
        if (mode === "update") {
          if (table === "flow_runs") {
            h.state.updates.push({ patch, status: f.eq.status });
          }
          if (h.state.updateError) {
            return resolve({ data: null, error: h.state.updateError });
          }
          const affected = Array.from({ length: h.state.updateAffects }, () => ({
            id: "run-old",
          }));
          return resolve({ data: affected, error: null });
        }
        return resolve({ data: rows(), error: null });
      },
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ error: null }),
    }),
  };
});

const engineSendText = vi.fn<
  (args: { conversationId: string; text: string }) => Promise<{ whatsapp_message_id: string }>
>(async () => ({ whatsapp_message_id: "wamid.1" }));
const engineSendInteractiveList = vi.fn(async () => ({
  whatsapp_message_id: "wamid.4",
}));

vi.mock("./meta-send", () => ({
  engineSendText: (...a: unknown[]) =>
    (engineSendText as unknown as (...x: unknown[]) => unknown)(...a),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "wamid.2" })),
  engineSendForm: vi.fn(async () => ({ whatsapp_message_id: "wamid.5" })),
  engineSendInteractiveButtons: vi.fn(async () => ({
    whatsapp_message_id: "wamid.3",
  })),
  engineSendInteractiveList: (...a: unknown[]) =>
    (engineSendInteractiveList as unknown as (...x: unknown[]) => unknown)(...a),
}));

import { dispatchInboundToFlows } from "./engine";
import type { ParsedInbound } from "./types";

// The real shape, trimmed: a material list whose metals continue and
// whose Glass row dead-ends at an `end` node.
const FLOW = {
  id: "flow-1",
  account_id: "acct-1",
  user_id: "u-1",
  status: "active",
  trigger_type: "keyword",
  // Greetings only — exactly why a row title can't restart the flow.
  trigger_config: { keywords: ["hi", "hello"], match_type: "exact" },
  entry_node_id: "start",
  fallback_policy: {},
  created_at: "2026-01-01T00:00:00Z",
};

const NODES = [
  {
    id: "n0",
    flow_id: "flow-1",
    node_key: "start",
    node_type: "start",
    config: { next_node_key: "ask_material" },
  },
  {
    id: "n1",
    flow_id: "flow-1",
    node_key: "ask_material",
    node_type: "send_list",
    config: {
      text: "Which material are you cutting?",
      button_label: "Choose material",
      sections: [
        {
          title: "Metals",
          rows: [
            {
              reply_id: "aluminium",
              title: "Aluminium",
              next_node_key: "ask_thickness",
            },
          ],
        },
        {
          title: "Other",
          rows: [
            { reply_id: "glass", title: "Glass", next_node_key: "decline" },
          ],
        },
      ],
    },
  },
  {
    id: "n2",
    flow_id: "flow-1",
    node_key: "ask_thickness",
    node_type: "send_message",
    config: { text: "What thickness?", next_node_key: "end_lost" },
  },
  {
    id: "n3",
    flow_id: "flow-1",
    node_key: "end_lost",
    node_type: "end",
    config: {},
  },
];

/** A run that finished at the end node, still parked on the list. */
function endedRun(status: string) {
  return {
    id: "run-old",
    flow_id: "flow-1",
    account_id: "acct-1",
    user_id: "u-1",
    contact_id: "ct-1",
    conversation_id: "cv-1",
    status,
    current_node_key: "ask_material",
    last_prompt_message_id: null,
    vars: {},
    reprompt_count: 2,
    started_at: "2026-01-01T00:00:00Z",
    last_advanced_at: "2026-01-01T00:05:00Z",
    ended_at: "2026-01-01T00:06:00Z",
    end_reason: "end_node",
  };
}

const TAP: ParsedInbound = {
  kind: "interactive_reply",
  reply_id: "aluminium",
  reply_title: "Aluminium",
  meta_message_id: "wamid.tap",
};

function dispatch(message: ParsedInbound = TAP) {
  return dispatchInboundToFlows({
    accountId: "acct-1",
    userId: "u-1",
    contactId: "ct-1",
    conversationId: "cv-1",
    message,
    isFirstInboundMessage: false,
  });
}

/** The UPDATE that flips a run back to active, if it happened. */
function reopenUpdate() {
  return h.state.updates.find((u) => u.patch.status === "active");
}

beforeEach(() => {
  h.state.activeRuns = [];
  h.state.endedRuns = [];
  h.state.flows = [FLOW];
  h.state.nodes = NODES;
  h.state.updates = [];
  h.state.updateAffects = 1;
  h.state.updateError = null;
  h.state.runQueries = [];
  h.state.inserted = [];
  engineSendText.mockClear();
  engineSendInteractiveList.mockClear();
});

describe("stale tap on a completed run", () => {
  it("revives the run and advances down the tapped branch", async () => {
    h.state.endedRuns = [endedRun("completed")];

    const result = await dispatch();

    expect(result.consumed).toBe(true);
    expect(result.flow_run_id).toBe("run-old");
    // Advanced to ask_thickness, which sends text — the proof the tap
    // did something rather than being swallowed.
    expect(engineSendText).toHaveBeenCalledTimes(1);
    expect(engineSendText.mock.calls[0][0]).toMatchObject({
      conversationId: "cv-1",
      text: "What thickness?",
    });
  });

  it("flips status back to active and clears the end markers", async () => {
    h.state.endedRuns = [endedRun("completed")];
    await dispatch();

    expect(reopenUpdate()?.patch).toMatchObject({
      status: "active",
      ended_at: null,
      end_reason: null,
      // A fresh answer, not a retry of the prompt.
      reprompt_count: 0,
    });
  });

  it("guards the UPDATE on the status it read, so a concurrent change loses", async () => {
    h.state.endedRuns = [endedRun("completed")];
    await dispatch();
    expect(reopenUpdate()?.status).toBe("completed");
  });

  it("revives a timed-out run too — the customer came back", async () => {
    h.state.endedRuns = [endedRun("timed_out")];
    const result = await dispatch();
    expect(result.consumed).toBe(true);
    expect(reopenUpdate()).toBeDefined();
  });

  it("starts no new run — it continues the old one", async () => {
    h.state.endedRuns = [endedRun("completed")];
    await dispatch();
    expect(h.state.inserted.filter((i) => i.table === "flow_runs")).toEqual([]);
  });
});

describe("taps that must NOT revive a run", () => {
  it("leaves a handed-off run alone — a human owns the thread", async () => {
    // The reopen query filters status IN ('completed','timed_out'), so a
    // handed_off row is never returned. Asserting via the query itself
    // keeps this honest even if the fake got more permissive.
    h.state.endedRuns = [endedRun("handed_off")];
    await dispatch();

    const reopenQuery = h.state.runQueries.find((q) => q.in.status);
    expect(reopenQuery?.in.status).toEqual(["completed", "timed_out"]);
    expect(reopenQuery?.in.status).not.toContain("handed_off");
    expect(reopenQuery?.in.status).not.toContain("paused_by_agent");
    expect(reopenQuery?.in.status).not.toContain("failed");
  });

  it("ignores a tap that matches no option on the last prompt", async () => {
    h.state.endedRuns = [endedRun("completed")];

    const result = await dispatch({
      kind: "interactive_reply",
      reply_id: "titanium", // never offered
      reply_title: "Titanium",
      meta_message_id: "wamid.x",
    });

    expect(reopenUpdate()).toBeUndefined();
    expect(engineSendText).not.toHaveBeenCalled();
    expect(result.consumed).toBe(false);
  });

  it("will not revive a run whose flow has since been deactivated", async () => {
    h.state.endedRuns = [endedRun("completed")];
    h.state.flows = [{ ...FLOW, status: "archived" }];

    const result = await dispatch();

    expect(reopenUpdate()).toBeUndefined();
    expect(engineSendText).not.toHaveBeenCalled();
    expect(result.consumed).toBe(false);
  });

  it("bails when the guarded UPDATE affects no rows (lost the race)", async () => {
    h.state.endedRuns = [endedRun("completed")];
    h.state.updateAffects = 0;

    const result = await dispatch();

    expect(engineSendText).not.toHaveBeenCalled();
    expect(result.consumed).toBe(false);
  });

  it("swallows the unique-index collision when a new run just started", async () => {
    h.state.endedRuns = [endedRun("completed")];
    h.state.updateError = { code: "23505", message: "duplicate key" };

    const result = await dispatch();

    expect(result.consumed).toBe(false);
    expect(engineSendText).not.toHaveBeenCalled();
  });

  it("does not look for an ended run when the inbound is plain text", async () => {
    // Typed text has to keep going to the entry trigger: reviving a
    // finished flow because someone said "hi" would hijack the greeting.
    h.state.endedRuns = [endedRun("completed")];

    await dispatch({
      kind: "text",
      text: "aluminium",
      meta_message_id: "wamid.t",
    });

    expect(h.state.runQueries.find((q) => q.in.status)).toBeUndefined();
    expect(reopenUpdate()).toBeUndefined();
  });

  it("does not touch the reopen path when a run is already active", async () => {
    h.state.activeRuns = [{ ...endedRun("active"), ended_at: null }];
    h.state.endedRuns = [endedRun("completed")];

    await dispatch();

    expect(h.state.runQueries.find((q) => q.in.status)).toBeUndefined();
  });
});
