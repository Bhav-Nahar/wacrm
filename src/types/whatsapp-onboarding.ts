export interface FbSdkLoginResponse {
  status?: 'connected' | 'not_authorized' | 'unknown'
  authResponse?: {
    code?: string
    accessToken?: string
    expiresIn?: number
    signedRequest?: string
    userID?: string
  } | null
}

export interface FbSdk {
  init: (opts: { appId: string; cookie?: boolean; xfbml?: boolean; version: string }) => void
  login: (cb: (r: FbSdkLoginResponse) => void, opts: Record<string, unknown>) => void
}

export interface EmbeddedSignupConnectStart {
  configured: boolean
  app_id: string
  config_id: string
  graph_version: string
}

export interface EmbeddedSignupConnectComplete {
  code: string
  state?: string | null
  source?: 'sdk' | 'redirect'
}

export interface MetaOAuthTokenResponse {
  access_token: string
  token_type?: string
  expires_in?: number
}

export interface MetaDebugTokenResponse {
  data?: {
    app_id?: string
    type?: string
    application?: string
    is_valid?: boolean
    issued_at?: number
    expires_at?: number
    granular_scopes?: Array<{
      scope: string
      target_ids?: string[]
    }>
    scopes?: string[]
    user_id?: string
  }
}

export interface MetaPhoneNumberRecord {
  id: string
  display_phone_number?: string
  verified_name?: string
  quality_rating?: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN'
  messaging_limit_tier?: string
}

export interface WhatsAppOnboardingStatus {
  connected: boolean
  status:
    | 'not_connected'
    | 'pending'
    | 'connected'
    | 'number_registered'
    | 'payment_required'
    | 'template_pending'
    | 'ready'
    | 'disabled'
    | 'reauth_required'
  status_detail: string | null
  display_phone_number: string | null
  verified_name: string | null
  quality_rating: string | null
  messaging_tier: string | null
  template_status: string | null
  can_send: boolean
  webhooks_ok: boolean
  registered: boolean
}
