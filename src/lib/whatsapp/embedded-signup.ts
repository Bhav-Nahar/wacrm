/**
 * WhatsApp Embedded Signup Service
 *
 * Implements the Meta 1-Click Embedded Signup flow:
 * 1. exchangeCodeForToken: Exchanges temporary OAuth code for a Business System User access token.
 * 2. discoverWabaId: Discovers the granted WhatsApp Business Account (WABA) ID from /debug_token scopes.
 * 3. fetchWabaPhoneNumbers: Retrieves the phone numbers attached to the newly connected WABA.
 * 4. subscribeWabaToApp: Subscribes Meta Webhooks for delivery receipts and inbound messages.
 * 5. registerPhoneNumber: Registers the phone number for Cloud API sending.
 * 6. completeEmbeddedSignup: Orchestrates full onboarding and securely stores encrypted credentials.
 */

import { randomInt } from 'crypto'

import { encrypt } from '@/lib/whatsapp/encryption'
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
  type MetaPhoneInfo,
} from '@/lib/whatsapp/meta-api'
import type {
  EmbeddedSignupConnectStart,
  MetaDebugTokenResponse,
  MetaOAuthTokenResponse,
  MetaPhoneNumberRecord,
} from '@/types/whatsapp-onboarding'
import { humanizeMetaError } from '@/lib/whatsapp/whatsapp-errors'
import type { SupabaseClient } from '@supabase/supabase-js'

export function getEmbeddedSignupCredentials(): {
  appId: string
  appSecret: string
  configId: string
  graphVersion: string
  configured: boolean
} {
  const appId = (process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || '').trim()
  const appSecret = (process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET || '').trim()
  const configId = (process.env.WHATSAPP_ES_CONFIG_ID || '').trim()
  const graphVersion = (process.env.WHATSAPP_GRAPH_VERSION || 'v21.0').trim()

  const configured = Boolean(appId && appSecret && configId)

  return { appId, appSecret, configId, graphVersion, configured }
}

/**
 * The two public ids the browser needs to open Meta's signup popup.
 *
 * Deliberately NOT a hosted landing URL. `business.facebook.com/messaging/
 * whatsapp/onboard/` is not a supported entry point — it answers "Sorry,
 * something went wrong" — so the Facebook JS SDK popup is the only flow that
 * works, and it needs no redirect URI at all: the code comes back to the page
 * that opened it. That is also why this works on localhost with no tunnel.
 */
export function getConnectStartConfig(): EmbeddedSignupConnectStart {
  const { appId, configId, graphVersion, configured } = getEmbeddedSignupCredentials()

  return {
    configured,
    app_id: appId,
    config_id: configId,
    graph_version: graphVersion,
  }
}

export interface ExchangeCodeOptions {
  code: string
  source?: 'sdk' | 'redirect'
  redirectUri?: string
}

/**
 * Exchanges the authorization code received from the Embedded Signup flow
 * for a business access token.
 */
export async function exchangeEmbeddedSignupCode(
  options: ExchangeCodeOptions
): Promise<string> {
  const { appId, appSecret, graphVersion } = getEmbeddedSignupCredentials()
  if (!appId || !appSecret) {
    throw new Error('META_APP_ID or META_APP_SECRET is not configured in environment.')
  }

  const { code, source = 'sdk', redirectUri } = options

  const params = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    code,
  })

  // Meta requires redirect_uri ONLY when the code was generated from a browser redirect,
  // NOT when using the JavaScript SDK popup (which generates an SDK-bound code).
  if (source === 'redirect' && redirectUri) {
    params.set('redirect_uri', redirectUri)
  }

  const url = `https://graph.facebook.com/${graphVersion}/oauth/access_token?${params.toString()}`
  const response = await fetch(url, { method: 'GET' })

  if (!response.ok) {
    let errorMsg = `Meta token exchange failed with HTTP ${response.status}`
    try {
      const errData = await response.json()
      if (errData?.error?.message) {
        errorMsg = errData.error.message
      }
    } catch {
      // response not JSON
    }
    throw new Error(errorMsg)
  }

  const data = (await response.json()) as MetaOAuthTokenResponse
  if (!data.access_token) {
    throw new Error('Meta returned no access token for the provided authorization code.')
  }

  return data.access_token
}

/**
 * Queries Meta's /debug_token endpoint to discover which WABA ID was actually
 * granted to this business token via granular scopes.
 */
export async function discoverWabaId(accessToken: string): Promise<string | null> {
  const { appId, appSecret, graphVersion } = getEmbeddedSignupCredentials()
  if (!appId || !appSecret) return null

  const params = new URLSearchParams({
    input_token: accessToken,
    access_token: `${appId}|${appSecret}`,
  })

  const url = `https://graph.facebook.com/${graphVersion}/debug_token?${params.toString()}`
  const response = await fetch(url, { method: 'GET' })

  if (!response.ok) return null

  const data = (await response.json()) as MetaDebugTokenResponse
  const scopes = data?.data?.granular_scopes || []

  for (const s of scopes) {
    if (s.scope === 'whatsapp_business_management' && s.target_ids && s.target_ids.length > 0) {
      return String(s.target_ids[0])
    }
  }

  return null
}

/**
 * Fetches phone numbers under the given WABA.
 */
export async function fetchWabaPhoneNumbers(
  wabaId: string,
  accessToken: string
): Promise<MetaPhoneNumberRecord[]> {
  const { graphVersion } = getEmbeddedSignupCredentials()
  const url = `https://graph.facebook.com/${graphVersion}/${wabaId}/phone_numbers`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!response.ok) {
    return []
  }

  const data = await response.json()
  return (data?.data as MetaPhoneNumberRecord[]) || []
}

export interface CompleteSignupArgs {
  accountId: string
  userId: string
  code: string
  source?: 'sdk' | 'redirect'
  redirectUri?: string
  supabaseAdmin: SupabaseClient
}

export interface CompleteSignupResult {
  success: boolean
  phone_number_id: string
  waba_id: string | null
  display_phone_number?: string
  verified_name?: string
  phone_info?: MetaPhoneInfo
  registered: boolean
  registration_error?: string | null
}

/**
 * Completes the full Embedded Signup onboarding process:
 * exchanges code -> discovers WABA -> fetches phone -> subscribes webhooks -> registers number -> stores encrypted credentials.
 */
export async function completeEmbeddedSignup(
  args: CompleteSignupArgs
): Promise<CompleteSignupResult> {
  const { accountId, userId, code, source = 'sdk', redirectUri, supabaseAdmin } = args

  // 1. Exchange temporary code for access token
  const accessToken = await exchangeEmbeddedSignupCode({ code, source, redirectUri })

  // 2. Discover WABA ID from Meta
  const wabaId = await discoverWabaId(accessToken)

  // 3. Fetch phone number ID
  let phoneNumberId = ''
  let phoneRecord: MetaPhoneNumberRecord | null = null

  if (wabaId) {
    const numbers = await fetchWabaPhoneNumbers(wabaId, accessToken)
    if (numbers.length > 0) {
      phoneRecord = numbers[0]
      phoneNumberId = phoneRecord.id
    }
  }

  // Two distinct failures, two distinct fixes — reporting "no phone number"
  // when Meta granted no WABA at all sends the user hunting in the wrong place.
  if (!wabaId) {
    throw new Error(
      'Meta did not grant access to a WhatsApp Business Account. Run the connection again and make sure an account is selected in the popup.'
    )
  }

  if (!phoneNumberId) {
    throw new Error(
      'Could not find a phone number associated with this WhatsApp Business Account. Please ensure you selected a phone number during signup.'
    )
  }

  // 4. Verify no other account has claimed this phone_number_id
  const { data: claimed, error: claimedError } = await supabaseAdmin
    .from('whatsapp_config')
    .select('account_id')
    .eq('phone_number_id', phoneNumberId)
    .neq('account_id', accountId)
    .maybeSingle()

  if (claimedError) {
    console.error('Error checking phone_number_id ownership:', claimedError)
  }

  if (claimed) {
    throw new Error(
      'This WhatsApp phone number is already linked to another account on this instance.'
    )
  }

  // 5. Verify Phone details with Meta
  let phoneInfo: MetaPhoneInfo | undefined
  try {
    phoneInfo = await verifyPhoneNumber({
      phoneNumberId,
      accessToken,
    })
  } catch (err) {
    console.warn('verifyPhoneNumber non-fatal warning during embedded signup:', err)
  }

  // 6. Subscribe WABA to this App's Webhooks
  let subscribedAppsAt: string | null = null
  if (wabaId) {
    try {
      await subscribeWabaToApp({ wabaId, accessToken })
      subscribedAppsAt = new Date().toISOString()
    } catch (err) {
      console.warn('subscribeWabaToApp non-fatal error:', err)
    }
  }

  // 7. Register Phone Number for Cloud API sending (using generated 6-digit PIN)
  //
  // The PIN is two-step verification on the tenant's number and Meta requires
  // it again on any future re-register, so it is stored (encrypted) rather
  // than discarded — see migration 040. randomInt, not Math.random: this is a
  // credential, and a predictable one is worth no more than none.
  let registeredAt: string | null = null
  let registrationError: string | null = null
  const pin = String(randomInt(100000, 1000000))

  try {
    const regResult = await registerPhoneNumber({
      phoneNumberId,
      accessToken,
      pin,
    })
    if (regResult.success) {
      registeredAt = new Date().toISOString()
    }
  } catch (err) {
    // Meta's raw text is the diagnostic; the mapped sentence is the part a
    // tenant can act on. `last_registration_error` is rendered verbatim in
    // Settings, so both go in — "(#131042) Invalid parameter" on its own
    // tells the reader nothing about adding a payment method.
    const raw = err instanceof Error ? err.message : String(err)
    registrationError = humanizeMetaError(raw)
    console.warn('registerPhoneNumber non-fatal during embedded signup:', raw)
  }

  // 8. Encrypt access token before storing
  const encryptedAccessToken = encrypt(accessToken)

  // 9. Persist into Supabase whatsapp_config table
  const { data: existing } = await supabaseAdmin
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .maybeSingle()

  const configRow = {
    account_id: accountId,
    phone_number_id: phoneNumberId,
    waba_id: wabaId || null,
    access_token: encryptedAccessToken,
    status: registrationError ? 'disconnected' : 'connected',
    connected_at: new Date().toISOString(),
    registered_at: registeredAt,
    // Only meaningful once Meta accepted it. Storing a PIN from a failed
    // register would claim the number carries a PIN it does not have.
    ...(registeredAt ? { registration_pin: encrypt(pin) } : {}),
    subscribed_apps_at: subscribedAppsAt,
    last_registration_error: registrationError,
    updated_at: new Date().toISOString(),
  }

  if (existing) {
    // `user_id` is deliberately NOT in the update: the column records who
    // originally created the row, and reconnecting is not a transfer of
    // ownership. Overwriting it would silently reassign a teammate's row to
    // whoever last pressed the button.
    const { error: updateError } = await supabaseAdmin
      .from('whatsapp_config')
      .update(configRow)
      .eq('account_id', accountId)

    if (updateError) {
      console.error('Failed to update whatsapp_config:', updateError)
      throw new Error(`Database error saving config: ${updateError.message}`)
    }
  } else {
    const { error: insertError } = await supabaseAdmin
      .from('whatsapp_config')
      .insert({ ...configRow, user_id: userId })

    if (insertError) {
      console.error('Failed to insert whatsapp_config:', insertError)
      throw new Error(`Database error saving config: ${insertError.message}`)
    }
  }

  return {
    success: true,
    phone_number_id: phoneNumberId,
    waba_id: wabaId,
    display_phone_number: phoneRecord?.display_phone_number || phoneInfo?.display_phone_number,
    verified_name: phoneRecord?.verified_name || phoneInfo?.verified_name,
    phone_info: phoneInfo,
    registered: registeredAt !== null,
    registration_error: registrationError,
  }
}
