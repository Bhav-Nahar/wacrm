import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendFlowMessage } from "./meta-api";

// Same stubbing contract as meta-api.test.ts: validation assertions run
// before the network call, so a never-resolving fetch makes an
// accidental fall-through hang rather than hit graph.facebook.com.
const neverFetch = () =>
  new Promise<Response>(() => {
    /* intentionally never resolves */
  });

const BASE_ARGS = {
  phoneNumberId: "test-phone",
  accessToken: "test-token",
  to: "1234567890",
  bodyText: "Tap below to get your quote",
  flowId: "1234567890123456",
  ctaLabel: "Start",
  screenId: "WELCOME",
  flowToken: "run-abc",
} as const;

describe("sendFlowMessage — validation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(neverFetch));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a missing flowId", async () => {
    await expect(
      sendFlowMessage({ ...BASE_ARGS, flowId: "" }),
    ).rejects.toThrow(/flowId/);
  });

  it("rejects a missing screenId", async () => {
    await expect(
      sendFlowMessage({ ...BASE_ARGS, screenId: "" }),
    ).rejects.toThrow(/screenId/);
  });

  it("rejects a missing flowToken", async () => {
    await expect(
      sendFlowMessage({ ...BASE_ARGS, flowToken: "" }),
    ).rejects.toThrow(/flowToken/);
  });

  it("rejects a CTA label over Meta's 20-char button limit", async () => {
    await expect(
      sendFlowMessage({ ...BASE_ARGS, ctaLabel: "x".repeat(21) }),
    ).rejects.toThrow(/20 chars/);
  });

  it("rejects an empty body", async () => {
    await expect(
      sendFlowMessage({ ...BASE_ARGS, bodyText: "" }),
    ).rejects.toThrow(/bodyText/);
  });
});

describe("sendFlowMessage — request body", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The explicit signature is what makes `mock.calls[0]` narrow to
  // [url, init]; an argless mock types it as [] and the destructure
  // below stops compiling.
  function captureFetch() {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ messages: [{ id: "wamid.TEST" }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("emits the interactive type:flow envelope Meta expects", async () => {
    const fetchMock = captureFetch();
    const result = await sendFlowMessage(BASE_ARGS);

    expect(result.messageId).toBe("wamid.TEST");
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);

    expect(body.type).toBe("interactive");
    expect(body.interactive.type).toBe("flow");
    expect(body.interactive.body.text).toBe(BASE_ARGS.bodyText);
    expect(body.interactive.action.name).toBe("flow");
    expect(body.interactive.action.parameters).toMatchObject({
      flow_message_version: "3",
      flow_token: "run-abc",
      flow_id: BASE_ARGS.flowId,
      flow_cta: "Start",
      // 'navigate' is the static variant — it is what keeps this
      // feature free of an RSA keypair and a decrypting endpoint.
      flow_action: "navigate",
      flow_action_payload: { screen: "WELCOME" },
    });
  });

  it("omits header and footer when not supplied", async () => {
    const fetchMock = captureFetch();
    await sendFlowMessage(BASE_ARGS);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.interactive.header).toBeUndefined();
    expect(body.interactive.footer).toBeUndefined();
  });

  it("includes header and footer when supplied", async () => {
    const fetchMock = captureFetch();
    await sendFlowMessage({
      ...BASE_ARGS,
      headerText: "Quick quote",
      footerText: "Takes 30 seconds",
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.interactive.header).toEqual({
      type: "text",
      text: "Quick quote",
    });
    expect(body.interactive.footer).toEqual({ text: "Takes 30 seconds" });
  });
});
