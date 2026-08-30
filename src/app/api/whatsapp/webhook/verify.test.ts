import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Meta's GET handshake — the one that decides whether ANY inbound message is
 * ever delivered.
 *
 * Kept apart from route.test.ts because that file's Supabase mock is shaped
 * for the POST path (`select().eq()`), while verification calls `select()` and
 * awaits it directly.
 */

const h = vi.hoisted(() => ({
  /** Rows the whatsapp_config select resolves with. */
  configs: [] as { id: string; verify_token: string | null }[],
  /** True once the DB was consulted — proves the env short-circuit worked. */
  dbQueried: false,
}))

vi.mock('next/server', () => ({
  after: () => {},
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => {
        h.dbQueried = true
        return Promise.resolve({ data: h.configs, error: null })
      },
    }),
  }),
}))

// Per-account tokens are stored encrypted; the handshake decrypts before
// comparing. Identity keeps the fixtures readable.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v.replace(/^enc:/, ''),
  encrypt: (v: string) => `enc:${v}`,
  isLegacyFormat: () => false,
}))

// Imported ONCE, not per test: route.ts drags in the automations engine, the
// flows engine, AI auto-reply and webhook delivery, and re-importing that graph
// inside every test pushed the first one past the 5s timeout under full-suite
// load. The env var is read per request, so a single import is still correct.
const { GET } = await import('./route')

const ORIGINAL_ENV = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN

function verifyRequest(token: string, challenge = 'CHALLENGE_123') {
  return new Request(
    `https://crm.example.com/api/whatsapp/webhook?hub.mode=subscribe&hub.challenge=${challenge}&hub.verify_token=${token}`,
  )
}

beforeEach(() => {
  h.configs = []
  h.dbQueried = false
  delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN
})

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN
  else process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = ORIGINAL_ENV
})

describe('webhook verification: instance-wide token (Embedded Signup)', () => {
  it('accepts the env token when NO account row carries a verify_token', async () => {
    // Exactly the Embedded Signup case: onboarding never asks for a verify
    // token, so every row has NULL. Before the env fallback this returned 403
    // forever and the instance silently received nothing.
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'instance-secret'
    h.configs = [{ id: 'cfg-1', verify_token: null }]

    const res = (await GET(verifyRequest('instance-secret'))) as Response

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('CHALLENGE_123')
  })

  it('answers without touching the database', async () => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'instance-secret'

    await GET(verifyRequest('instance-secret'))

    expect(h.dbQueried).toBe(false)
  })

  it('rejects a token that matches neither the env nor any row', async () => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'instance-secret'
    h.configs = [{ id: 'cfg-1', verify_token: 'enc:tenant-secret' }]

    const res = (await GET(verifyRequest('wrong-secret'))) as unknown as {
      status: number
    }

    expect(res.status).toBe(403)
  })
})

describe('webhook verification: per-account tokens still work', () => {
  it('falls back to a stored row token when no env token is set', async () => {
    // Manually-configured instances must be untouched by the ES fallback.
    h.configs = [{ id: 'cfg-1', verify_token: 'enc:tenant-secret' }]

    const res = (await GET(verifyRequest('tenant-secret'))) as Response

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('CHALLENGE_123')
    expect(h.dbQueried).toBe(true)
  })

  it('still matches a row token when an env token is set but differs', async () => {
    // A mixed instance: some tenants onboarded by hand, some via signup.
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'instance-secret'
    h.configs = [{ id: 'cfg-1', verify_token: 'enc:tenant-secret' }]

    const res = (await GET(verifyRequest('tenant-secret'))) as Response

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('CHALLENGE_123')
  })

  it('ignores an empty env token rather than accepting an empty challenge', async () => {
    // A blank var must not turn into "match anything falsy".
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = '   '
    h.configs = [{ id: 'cfg-1', verify_token: 'enc:tenant-secret' }]

    const res = (await GET(verifyRequest('tenant-secret'))) as Response

    expect(res.status).toBe(200)
    expect(h.dbQueried).toBe(true)
  })
})
