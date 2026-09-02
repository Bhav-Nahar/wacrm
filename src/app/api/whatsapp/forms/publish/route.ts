import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  createFlow,
  publishFlow,
  deprecateFlow,
  listFlows,
} from '@/lib/whatsapp/meta-api'
import {
  buildFlowJson,
  formFieldsSignature,
  validateFormFields,
  GENERATED_SCREEN_ID,
  type FormField,
} from '@/lib/whatsapp/flow-json'

/**
 * Generate, create and publish a WhatsApp Flow from a field list.
 *
 * This is the endpoint that means a wacrm user never opens Meta's Flow
 * Builder: the `send_form` node config carries `form_fields`, this
 * route turns them into Flow JSON, creates the Flow on the account's
 * WABA, publishes it, and hands back the ids the node needs.
 *
 * Sequencing matters, because publishing is irreversible:
 *
 *   validate locally  → nothing spent on a form we know Meta will reject
 *   create as DRAFT   → a bad generated JSON dies here, reversibly
 *   publish           → the point of no return
 *   deprecate the old → best-effort, AFTER the new one is live
 *
 * The old Flow is retired last and its failure is swallowed. By that
 * point the new Flow is published and the caller is about to point the
 * node at it; turning "couldn't tidy up the old one" into a failed save
 * would be a worse lie than leaving a deprecated Flow behind.
 */
export async function POST(request: Request) {
  try {
    // Same role gate as the flow builder itself — authoring a form is
    // authoring a flow.
    const { supabase, accountId, userId } = await requireRole('agent')

    // Each publish mints a permanent object on the user's WABA, so this
    // is rate-limited harder than a read would be. Reuses the send
    // bucket's shape; keyed separately so it has its own budget.
    const limit = checkRateLimit(`forms-publish:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json()
    const fields = (body?.form_fields ?? []) as FormField[]
    const submitLabel: string = body?.submit_label?.trim() || 'Submit'
    const formTitle: string | undefined = body?.form_title?.trim() || undefined
    const name: string = body?.name?.trim() || 'wacrm form'
    // The Flow this node currently points at, if any. Retired on success.
    const previousFlowId: string | null = body?.previous_flow_id || null

    // Local validation first — Meta's rejections arrive as schema
    // complaints that cannot be pointed at a specific field in the UI.
    const check = validateFormFields(fields, submitLabel)
    if (!check.ok) {
      return NextResponse.json(
        { error: check.errors.join(' '), errors: check.errors },
        { status: 400 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()
    if (configError || !config) {
      return NextResponse.json(
        { error: 'Connect WhatsApp before creating a form.' },
        { status: 400 },
      )
    }
    if (!config.waba_id) {
      // Flows live on the WABA, not the phone number. An older config
      // row can have a phone_number_id and no waba_id.
      return NextResponse.json(
        {
          error:
            'This WhatsApp connection has no WABA id on record. Reconnect WhatsApp so we can create Flows on it.',
        },
        { status: 400 },
      )
    }

    const accessToken = decrypt(config.access_token)
    const flowJson = buildFlowJson({ fields, submitLabel, title: formTitle })

    let created: { id: string; validationErrors: unknown[] }
    try {
      created = await createFlow({
        wabaId: config.waba_id,
        accessToken,
        name,
        flowJson,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // The permission case is the one worth naming, because the fix is
      // in Meta's Business Settings and not in wacrm.
      const isPermission =
        /permission/i.test(message) ||
        /\(#200\)/.test(message) ||
        /cannot be loaded/i.test(message)
      return NextResponse.json(
        {
          error: isPermission
            ? `WhatsApp refused to create the form: ${message}. The connected token needs "whatsapp_business_management" on this WhatsApp Business Account.`
            : `WhatsApp refused to create the form: ${message}`,
        },
        { status: 400 },
      )
    }

    if (created.validationErrors.length > 0) {
      // Created but unpublishable. It is still a DRAFT, so it can be
      // reported without leaving anything permanent behind.
      return NextResponse.json(
        {
          error: 'WhatsApp rejected the generated form.',
          validation_errors: created.validationErrors,
        },
        { status: 400 },
      )
    }

    try {
      await publishFlow({ flowId: created.id, accessToken })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return NextResponse.json(
        {
          error: `The form was created but could not be published: ${message}`,
          meta_flow_id: created.id,
        },
        { status: 400 },
      )
    }

    // Past the point of no return — the new Flow is live. Everything
    // from here is tidying and must not fail the request.
    if (previousFlowId && previousFlowId !== created.id) {
      try {
        await deprecateFlow({ flowId: previousFlowId, accessToken })
      } catch (err) {
        console.warn(
          `[forms] published ${created.id} but could not deprecate ${previousFlowId}:`,
          err instanceof Error ? err.message : err,
        )
      }
    }

    return NextResponse.json({
      meta_flow_id: created.id,
      // We generated the JSON, so we know the screen id — the user
      // never has to find or type it.
      screen_id: GENERATED_SCREEN_ID,
      published_signature: formFieldsSignature(fields, submitLabel, formTitle),
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/**
 * List the Flows already on this account's WABA.
 *
 * Read-only, and useful for two things: showing what a previous save
 * created, and letting someone point a node at a Flow they authored in
 * Meta's Flow Builder rather than here.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('agent')

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('waba_id, access_token')
      .eq('account_id', accountId)
      .single()
    if (!config?.waba_id) {
      return NextResponse.json({ flows: [] })
    }

    const flows = await listFlows({
      wabaId: config.waba_id,
      accessToken: decrypt(config.access_token),
    })
    return NextResponse.json({ flows })
  } catch (error) {
    return toErrorResponse(error)
  }
}
