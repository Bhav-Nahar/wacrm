import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { completeEmbeddedSignup } from '@/lib/whatsapp/embedded-signup'

// Service-role client. Embedded Signup writes whatsapp_config on behalf of
// the account and has to see rows belonging to OTHER accounts to detect a
// phone_number_id already claimed elsewhere — invisible under the caller's
// own RLS scope, and the conflict has to be caught before Meta is touched.
let _adminClient: ReturnType<typeof createAdminClient> | null = null
function getSupabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * POST /api/whatsapp/connect
 *
 * Completes Meta Embedded Signup: takes the authorization code from the
 * popup, exchanges it server-side (the app secret never reaches the browser),
 * and persists the resulting credentials.
 */
export async function POST(request: Request) {
  try {
    // Connecting WhatsApp replaces the account's entire messaging identity and
    // registers a phone number at Meta — a side effect no rollback here can
    // undo. Settings-class, so 'admin', matching the templates routes rather
    // than the older config route's membership-only check.
    const { accountId, userId } = await requireRole('admin')

    const body = await request.json()
    const { code, source = 'sdk', redirect_uri } = body

    if (!code || typeof code !== 'string') {
      return NextResponse.json(
        { error: 'Authorization code is required.' },
        { status: 400 }
      )
    }

    const result = await completeEmbeddedSignup({
      accountId,
      userId,
      code,
      source,
      redirectUri: redirect_uri,
      supabaseAdmin: getSupabaseAdmin(),
    })

    return NextResponse.json({
      success: true,
      data: result,
    })
  } catch (error) {
    // Auth failures map to 401/403 before the generic branch below, which
    // reports everything as a 500 — telling an agent their signup failed when
    // the real answer is "ask an admin" sends them chasing Meta for nothing.
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error)
    }
    const message =
      error instanceof Error ? error.message : 'Failed to complete WhatsApp connection'
    console.error('Error in POST /api/whatsapp/connect:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
