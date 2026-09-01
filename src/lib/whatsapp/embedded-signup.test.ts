import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  discoverWabaId,
  exchangeEmbeddedSignupCode,
  fetchWabaPhoneNumbers,
  getConnectStartConfig,
  getEmbeddedSignupCredentials,
  completeEmbeddedSignup,
} from './embedded-signup'
import {
  explainMetaError,
  isMetaBillingError,
  isMetaPermanentError,
  isMetaReauthError,
  humanizeMetaError,
} from './whatsapp-errors'

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('WhatsApp Embedded Signup & Error Helpers', () => {
  const originalEnv = { ...process.env }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env.META_APP_ID = 'TEST_APP_123'
    process.env.META_APP_SECRET = 'TEST_SECRET_456'
    process.env.WHATSAPP_ES_CONFIG_ID = 'TEST_CONFIG_789'
    process.env.ENCRYPTION_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

    fetchMock = vi.fn().mockResolvedValue(okResponse({ success: true }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.unstubAllGlobals()
  })

  describe('getEmbeddedSignupCredentials', () => {
    it('returns configured=true when all credentials are set', () => {
      const creds = getEmbeddedSignupCredentials()
      expect(creds.configured).toBe(true)
      expect(creds.appId).toBe('TEST_APP_123')
      expect(creds.appSecret).toBe('TEST_SECRET_456')
      expect(creds.configId).toBe('TEST_CONFIG_789')
    })

    it('supports FACEBOOK_APP_ID and FACEBOOK_APP_SECRET fallback', () => {
      delete process.env.META_APP_ID
      delete process.env.META_APP_SECRET
      process.env.FACEBOOK_APP_ID = 'FB_APP_123'
      process.env.FACEBOOK_APP_SECRET = 'FB_SECRET_456'

      const creds = getEmbeddedSignupCredentials()
      expect(creds.configured).toBe(true)
      expect(creds.appId).toBe('FB_APP_123')
      expect(creds.appSecret).toBe('FB_SECRET_456')
    })

    it('returns configured=false when any required key is missing', () => {
      delete process.env.WHATSAPP_ES_CONFIG_ID
      const creds = getEmbeddedSignupCredentials()
      expect(creds.configured).toBe(false)
    })
  })

  describe('getConnectStartConfig', () => {
    it('returns only the public ids the SDK popup needs', () => {
      const startConfig = getConnectStartConfig()
      expect(startConfig.configured).toBe(true)
      expect(startConfig.app_id).toBe('TEST_APP_123')
      expect(startConfig.config_id).toBe('TEST_CONFIG_789')
      expect(startConfig.graph_version).toBe('v21.0')
    })

    it('never leaks the app secret to the browser', () => {
      // This value is handed to a client component verbatim.
      expect(Object.values(getConnectStartConfig())).not.toContain('TEST_SECRET_456')
    })
  })

  describe('exchangeEmbeddedSignupCode', () => {
    it('exchanges code for access_token without redirect_uri when source=sdk', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          access_token: 'EAAB_TEST_ACCESS_TOKEN',
          token_type: 'bearer',
        })
      )

      const token = await exchangeEmbeddedSignupCode({
        code: 'TEST_CODE_XYZ',
        source: 'sdk',
      })

      expect(token).toBe('EAAB_TEST_ACCESS_TOKEN')
      const [url] = fetchMock.mock.calls[0]
      expect(url).toContain('/oauth/access_token')
      expect(url).toContain('client_id=TEST_APP_123')
      expect(url).toContain('code=TEST_CODE_XYZ')
      expect(url).not.toContain('redirect_uri')
    })

    it('includes redirect_uri when source=redirect', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          access_token: 'EAAB_TEST_ACCESS_TOKEN_2',
        })
      )

      const token = await exchangeEmbeddedSignupCode({
        code: 'TEST_CODE_REDIRECT',
        source: 'redirect',
        redirectUri: 'https://crm.example.com/api/whatsapp/callback',
      })

      expect(token).toBe('EAAB_TEST_ACCESS_TOKEN_2')
      const [url] = fetchMock.mock.calls[0]
      expect(url).toContain('redirect_uri=https%3A%2F%2Fcrm.example.com%2Fapi%2Fwhatsapp%2Fcallback')
    })

    it('throws meaningful error message when Meta returns error', async () => {
      fetchMock.mockResolvedValueOnce(
        errorResponse(400, {
          error: {
            message: 'Invalid verification code format.',
            code: 100,
          },
        })
      )

      await expect(
        exchangeEmbeddedSignupCode({ code: 'INVALID_CODE' })
      ).rejects.toThrow('Invalid verification code format.')
    })
  })

  describe('discoverWabaId', () => {
    it('extracts WABA ID from granular_scopes', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          data: {
            is_valid: true,
            granular_scopes: [
              {
                scope: 'whatsapp_business_management',
                target_ids: ['WABA_TARGET_999'],
              },
            ],
          },
        })
      )

      const wabaId = await discoverWabaId('EAAB_TOKEN')
      expect(wabaId).toBe('WABA_TARGET_999')
      const [url] = fetchMock.mock.calls[0]
      expect(url).toContain('/debug_token')
      expect(url).toContain('input_token=EAAB_TOKEN')
    })

    it('returns null if scope is missing or target_ids is empty', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          data: {
            is_valid: true,
            granular_scopes: [],
          },
        })
      )

      const wabaId = await discoverWabaId('EAAB_TOKEN')
      expect(wabaId).toBeNull()
    })
  })

  describe('fetchWabaPhoneNumbers', () => {
    it('fetches phone numbers associated with WABA', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          data: [
            {
              id: 'PHONE_ID_111',
              display_phone_number: '+1 555-0199',
              verified_name: 'Acme Test Store',
              quality_rating: 'GREEN',
            },
          ],
        })
      )

      const numbers = await fetchWabaPhoneNumbers('WABA_TARGET_999', 'EAAB_TOKEN')
      expect(numbers).toHaveLength(1)
      expect(numbers[0].id).toBe('PHONE_ID_111')
      expect(numbers[0].display_phone_number).toBe('+1 555-0199')
    })
  })

  describe('completeEmbeddedSignup', () => {
    it('completes the full onboarding flow and persists encrypted token in DB', async () => {
      // 1. exchange code mock
      fetchMock.mockResolvedValueOnce(
        okResponse({
          access_token: 'EAAB_ACCESS_TOKEN_FLOW',
        })
      )
      // 2. debug token mock (WABA discovery)
      fetchMock.mockResolvedValueOnce(
        okResponse({
          data: {
            is_valid: true,
            granular_scopes: [
              {
                scope: 'whatsapp_business_management',
                target_ids: ['WABA_555'],
              },
            ],
          },
        })
      )
      // 3. fetch phone numbers
      fetchMock.mockResolvedValueOnce(
        okResponse({
          data: [
            {
              id: 'PHONE_555',
              display_phone_number: '+1 555-1234',
              verified_name: 'Acme Corp',
            },
          ],
        })
      )
      // 4. verifyPhoneNumber mock
      fetchMock.mockResolvedValueOnce(
        okResponse({
          id: 'PHONE_555',
          display_phone_number: '+1 555-1234',
          verified_name: 'Acme Corp',
        })
      )
      // 5. subscribeWabaToApp mock
      fetchMock.mockResolvedValueOnce(okResponse({ success: true }))
      // 6. registerPhoneNumber mock
      fetchMock.mockResolvedValueOnce(okResponse({ success: true }))

      // Mock Supabase admin client
      let savedRow: Record<string, unknown> | null = null
      const mockSupabaseAdmin = {
        from: (table: string) => {
          expect(table).toBe('whatsapp_config')
          return {
            select: () => ({
              eq: () => ({
                neq: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
            insert: async (row: Record<string, unknown>) => {
              savedRow = row
              return { error: null }
            },
            update: async (row: Record<string, unknown>) => {
              savedRow = row
              return {
                eq: () => ({ error: null }),
              }
            },
          }
        },
      } as unknown as SupabaseClient

      const result = await completeEmbeddedSignup({
        accountId: '00000000-0000-0000-0000-000000000001',
        userId: '11111111-1111-1111-1111-111111111111',
        code: 'AUTH_CODE_VALID',
        source: 'sdk',
        supabaseAdmin: mockSupabaseAdmin,
      })

      expect(result.success).toBe(true)
      expect(result.phone_number_id).toBe('PHONE_555')
      expect(result.waba_id).toBe('WABA_555')
      expect(result.display_phone_number).toBe('+1 555-1234')
      expect(result.registered).toBe(true)

      // Read through a fresh binding: `savedRow` is only ever written inside
      // the mock's closures, which TypeScript's control-flow analysis cannot
      // see, so it narrows the original to `null` and every property access
      // below fails to compile.
      const saved = savedRow as Record<string, unknown> | null

      expect(saved).not.toBeNull()
      expect(saved?.account_id).toBe('00000000-0000-0000-0000-000000000001')
      expect(saved?.phone_number_id).toBe('PHONE_555')
      // Ensure token is encrypted (contains colon delimiter IV:authTag:ciphertext)
      expect(typeof saved?.access_token).toBe('string')
      expect((saved?.access_token as string).split(':').length).toBe(3)
      // The PIN is a credential on the tenant's number — stored, and stored
      // encrypted, never in the clear.
      expect(typeof saved?.registration_pin).toBe('string')
      expect((saved?.registration_pin as string).split(':').length).toBe(3)
      expect(saved?.registration_pin).not.toMatch(/^\d{6}$/)
    })
  })

  describe('whatsapp-errors helpers', () => {
    it('correctly maps 190 and 133004 to reauth=true', () => {
      expect(isMetaReauthError(190)).toBe(true)
      expect(isMetaReauthError(133004)).toBe(true)
      expect(isMetaReauthError(0, 'OAuthException: Session has expired')).toBe(true)
    })

    it('correctly maps 131042 to billing=true', () => {
      expect(isMetaBillingError(131042)).toBe(true)
      expect(isMetaBillingError(0, 'no payment method on account')).toBe(true)
    })

    it('correctly maps permanent delivery error codes', () => {
      expect(isMetaPermanentError(131026)).toBe(true)
      expect(isMetaPermanentError(131047)).toBe(true)
      expect(isMetaPermanentError(130472)).toBe(true)
      expect(isMetaPermanentError(131049)).toBe(false)
    })

    it('provides human-readable explanations for Meta codes', () => {
      const exp190 = explainMetaError(190)
      expect(exp190.message).toContain('Meta Business Settings')

      const exp131042 = explainMetaError(131042)
      expect(exp131042.message).toContain('valid payment method')
    })
  })

  describe('humanizeMetaError', () => {
    it('recovers the code Meta embeds in its own message text', () => {
      // The whole reason this works without meta-api threading a code around.
      const out = humanizeMetaError(
        '(#131047) Message failed to send because more than 24 hours have passed',
      )
      expect(out).toContain('only an approved template can be delivered')
    })

    it('keeps Meta’s original text alongside the explanation', () => {
      // The explanation is for the customer; the raw text is for whoever they
      // forward it to. Losing either one costs somebody an hour.
      const raw = '(#131042) Invalid parameter'
      const out = humanizeMetaError(raw)
      expect(out).toContain('payment method')
      expect(out).toContain(raw)
    })

    it('prefers an explicitly supplied code over the text', () => {
      expect(humanizeMetaError('something opaque', 131047)).toContain(
        'only an approved template can be delivered',
      )
    })

    it('falls back to wording when there is no code at all', () => {
      expect(
        humanizeMetaError('Business is not eligible to send paid messages'),
      ).toContain('payment method')
      expect(humanizeMetaError('Error validating access token')).toContain(
        'expired or was revoked',
      )
    })

    it('returns an unrecognised error untouched', () => {
      // A confident wrong explanation is worse than none — this string is
      // rendered verbatim in the broadcast UI.
      const raw = '(#999999) Some brand new Meta failure'
      expect(humanizeMetaError(raw)).toBe(raw)
      expect(humanizeMetaError('connection reset by peer')).toBe(
        'connection reset by peer',
      )
    })

    it('does not double-wrap when called twice', () => {
      // Guards the failure mode where a retry path humanizes an already
      // humanized string and nests "(Meta: … (Meta: …))".
      const once = humanizeMetaError('(#131042) Invalid parameter')
      expect(humanizeMetaError(once)).toBe(once)
    })
  })
})
