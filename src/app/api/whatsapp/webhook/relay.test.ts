import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Relay wiring in the webhook route: what gets forwarded, and that our own
// processing runs regardless of what the relay does.
const h = vi.hoisted(() => ({
  afterCallbacks: [] as (() => Promise<void> | void)[],
  configLookups: 0,
  ownRows: [{ phone_number_id: 'PN_OURS', waba_id: 'WABA_OURS' }],
  listError: null as { message: string } | null,
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => { h.afterCallbacks.push(cb) },
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, init }) },
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      // relayIfForeign: `await select('phone_number_id, waba_id')`
      // processWebhook: `select('*').eq('phone_number_id', …)` → no rows, so
      // processing stops at the config lookup (counted to prove it ran).
      select: () => ({
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: h.listError ? null : h.ownRows, error: h.listError }),
        eq: () => { h.configLookups++; return Promise.resolve({ data: [], error: null }) },
      }),
    }),
  }),
}))
vi.mock('@/lib/whatsapp/webhook-signature', () => ({ verifyMetaWebhookSignature: () => true }))
vi.mock('@/lib/whatsapp/template-webhook', () => ({
  isTemplateWebhookField: () => false,
  handleTemplateWebhookChange: vi.fn(),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 't', encrypt: (v: string) => v, isLegacyFormat: () => false }))
vi.mock('@/lib/whatsapp/meta-api', () => ({ getMediaUrl: vi.fn(), downloadMedia: vi.fn() }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: vi.fn() }))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: vi.fn() }))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn() }))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn() }))

import { POST } from './route'

const payload = (pn: string) =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA_X', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: pn, display_phone_number: '1' },
      contacts: [{ profile: { name: 'A' }, wa_id: '919800000000' }],
      messages: [{ id: 'wamid.1', from: '919800000000', timestamp: '1', type: 'text', text: { body: 'hi' } }],
    } }] }],
  })

async function deliver(raw: string) {
  const req = new Request('https://x/api/whatsapp/webhook', {
    method: 'POST', body: raw, headers: { 'x-hub-signature-256': 'sha256=abc' },
  })
  const res = await POST(req)
  for (const cb of h.afterCallbacks.splice(0)) await cb()
  return res as unknown as { init?: { status?: number } }
}

const fetchMock = vi.fn()
beforeEach(() => {
  h.configLookups = 0
  h.listError = null
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('WHATSAPP_WEBHOOK_FORWARD_URL', 'https://pinzo.test/hook')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('webhook relay', () => {
  it("forwards another app's event byte-for-byte with Meta's signature", async () => {
    const raw = payload('PN_PINZO')
    const res = await deliver(raw)
    expect(res.init?.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://pinzo.test/hook')
    expect(init.body).toBe(raw)
    expect(init.headers['x-hub-signature-256']).toBe('sha256=abc')
    expect(h.configLookups).toBe(1) // our own processing still ran
  })

  it('does not forward our own number', async () => {
    await deliver(payload('PN_OURS'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.configLookups).toBe(1)
  })

  it('does nothing extra when the relay is not configured', async () => {
    vi.stubEnv('WHATSAPP_WEBHOOK_FORWARD_URL', '')
    await deliver(payload('PN_PINZO'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.configLookups).toBe(1)
  })

  it('a failing receiver never breaks our processing', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    await deliver(payload('PN_PINZO'))
    expect(h.configLookups).toBe(1)
  })

  it('forwards when our config list cannot be read', async () => {
    h.listError = { message: 'db down' }
    await deliver(payload('PN_OURS'))
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
