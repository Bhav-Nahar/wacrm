import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFlow,
  publishFlow,
  deprecateFlow,
  deleteDraftFlow,
  listFlows,
  DEFAULT_FLOW_CATEGORY,
} from "./meta-api";
import { buildFlowJson, type FormField } from "./flow-json";

const AUTH = { accessToken: "test-token" };
const WABA = { wabaId: "waba-1", ...AUTH };

const FIELDS: FormField[] = [
  { name: "full_name", label: "Your name", type: "text", required: true },
];

function jsonOk(body: unknown) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify(body), { status: 200 }),
  );
}

function jsonErr(status: number, body: unknown) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify(body), { status }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("createFlow", () => {
  it("posts name, categories and a SERIALISED flow_json", async () => {
    const fetchMock = jsonOk({ id: "flow-99", validation_errors: [] });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createFlow({
      ...WABA,
      name: "Quote request",
      flowJson: buildFlowJson({ fields: FIELDS }),
    });

    expect(result.id).toBe("flow-99");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/waba-1/flows");
    expect(init?.method).toBe("POST");

    const body = new URLSearchParams(init?.body as string);
    expect(body.get("name")).toBe("Quote request");
    // Categories must be a JSON array string, not a bare word.
    expect(body.get("categories")).toBe(`["${DEFAULT_FLOW_CATEGORY}"]`);
    // flow_json travels as a string; the caller passes an object.
    const sent = JSON.parse(body.get("flow_json") as string);
    expect(sent.screens[0].id).toBe("FORM");
    // Meta's own template syntax must reach it intact.
    expect(JSON.stringify(sent)).toContain("${form.full_name}");
  });

  it("returns Meta's validation errors rather than hiding them", async () => {
    vi.stubGlobal(
      "fetch",
      jsonOk({ id: "flow-99", validation_errors: [{ error: "NOPE" }] }),
    );
    const r = await createFlow({
      ...WABA,
      name: "x",
      flowJson: buildFlowJson({ fields: FIELDS }),
    });
    expect(r.validationErrors).toEqual([{ error: "NOPE" }]);
  });

  it("throws when Meta accepts the call but returns no id", async () => {
    vi.stubGlobal("fetch", jsonOk({ validation_errors: [] }));
    await expect(
      createFlow({
        ...WABA,
        name: "x",
        flowJson: buildFlowJson({ fields: FIELDS }),
      }),
    ).rejects.toThrow(/returned no id/);
  });

  it("surfaces a permission failure", async () => {
    vi.stubGlobal(
      "fetch",
      jsonErr(403, {
        error: { message: "(#200) Permissions error", code: 200 },
      }),
    );
    await expect(
      createFlow({
        ...WABA,
        name: "x",
        flowJson: buildFlowJson({ fields: FIELDS }),
      }),
    ).rejects.toThrow(/Permissions error/);
  });

  it("validates its own arguments before spending a request", async () => {
    const fetchMock = jsonOk({ id: "x" });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createFlow({
        ...AUTH,
        wabaId: "",
        name: "x",
        flowJson: {},
      }),
    ).rejects.toThrow(/wabaId/);
    await expect(
      createFlow({ ...WABA, name: "  ", flowJson: {} }),
    ).rejects.toThrow(/name/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("publishFlow", () => {
  it("POSTs to the publish edge", async () => {
    const fetchMock = jsonOk({ success: true });
    vi.stubGlobal("fetch", fetchMock);
    await publishFlow({ flowId: "flow-99", ...AUTH });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/flow-99/publish");
    expect(init?.method).toBe("POST");
  });

  it("throws on a validation failure so a broken Flow is never treated as live", async () => {
    vi.stubGlobal(
      "fetch",
      jsonErr(400, {
        error: { message: "Flow has validation errors", code: 139000 },
      }),
    );
    await expect(
      publishFlow({ flowId: "flow-99", ...AUTH }),
    ).rejects.toThrow(/validation errors/);
  });
});

describe("deprecateFlow / deleteDraftFlow", () => {
  it("deprecate hits the deprecate edge", async () => {
    const fetchMock = jsonOk({ success: true });
    vi.stubGlobal("fetch", fetchMock);
    await deprecateFlow({ flowId: "old", ...AUTH });
    expect(fetchMock.mock.calls[0][0]).toContain("/old/deprecate");
  });

  it("delete uses DELETE on the flow itself", async () => {
    const fetchMock = jsonOk({ success: true });
    vi.stubGlobal("fetch", fetchMock);
    await deleteDraftFlow({ flowId: "draft", ...AUTH });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/draft$/);
    expect(init?.method).toBe("DELETE");
  });

  it("surfaces Meta's refusal to delete a published Flow", async () => {
    // The immutability constraint, seen from the API.
    vi.stubGlobal(
      "fetch",
      jsonErr(400, {
        error: { message: "Cannot delete a published Flow", code: 139001 },
      }),
    );
    await expect(
      deleteDraftFlow({ flowId: "live", ...AUTH }),
    ).rejects.toThrow(/published Flow/);
  });
});

describe("listFlows", () => {
  it("returns the data array", async () => {
    vi.stubGlobal(
      "fetch",
      jsonOk({
        data: [
          {
            id: "f1",
            name: "Quote",
            status: "PUBLISHED",
            categories: ["OTHER"],
            validation_errors: [],
          },
        ],
        paging: { cursors: {} },
      }),
    );
    const flows = await listFlows(WABA);
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ id: "f1", status: "PUBLISHED" });
  });

  it("returns an empty array when the WABA has no Flows", async () => {
    vi.stubGlobal("fetch", jsonOk({ data: [] }));
    expect(await listFlows(WABA)).toEqual([]);
  });

  it("does not blow up when Meta omits `data` entirely", async () => {
    vi.stubGlobal("fetch", jsonOk({}));
    expect(await listFlows(WABA)).toEqual([]);
  });
});
