import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveFallbackPolicy } from '@/lib/flows/fallback'
import { handOffConversationToHuman } from '@/lib/flows/engine'
import { engineSendText } from '@/lib/flows/meta-send'

/**
 * Sweep abandoned active flow runs.
 *
 * Reads each active run's parent-flow `fallback_policy.on_timeout_hours`
 * to compute the staleness cutoff (default 24h), then marks any run
 * past its cutoff as `timed_out`. Writes a matching `flow_run_events`
 * row for the audit trail.
 *
 * Without this sweep, a customer who abandons a flow mid-conversation
 * keeps a row in `idx_one_active_run_per_contact` (the partial unique
 * index on `flow_runs WHERE status='active'`) forever — blocking any
 * new triggers for them. The cron is therefore not optional.
 *
 * Auth: re-uses `AUTOMATION_CRON_SECRET` so operators only have one
 * secret to provision. The two endpoints (`/api/automations/cron`
 * and this one) are independent operations; we keep them on separate
 * URLs so one failing doesn't block the other.
 *
 * Hosting: hit on a schedule (Vercel Cron / GitHub Actions / external
 * pinger). A 5-minute interval is more than enough for a 24h timeout
 * default; once per hour would also be acceptable for low-volume
 * tenants.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  // Constant-time compare so an attacker who can hit the endpoint
  // can't recover the secret byte-by-byte from response-time deltas.
  // Length pre-check is required by timingSafeEqual (throws otherwise)
  // and leaks only the length itself, which isn't sensitive.
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const now = new Date()

  // Pull all currently-active runs along with their parent flow's
  // fallback_policy. Joined in one query — the small set of active
  // runs per tenant keeps this cheap.
  const { data: runs, error } = await admin
    .from('flow_runs')
    .select(
      'id, flow_id, user_id, account_id, contact_id, conversation_id, current_node_key, last_advanced_at, flows ( fallback_policy ), conversations ( status, assigned_agent_id )',
    )
    .eq('status', 'active')

  if (error) {
    console.error('[flows-cron] active-run scan failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!runs?.length) return NextResponse.json({ swept: 0, nudged: 0 })

  type Row = {
    id: string
    flow_id: string
    user_id: string
    account_id: string
    contact_id: string | null
    conversation_id: string | null
    current_node_key: string | null
    last_advanced_at: string
    flows: { fallback_policy: unknown } | { fallback_policy: unknown }[] | null
    conversations:
      | { status: string; assigned_agent_id: string | null }
      | { status: string; assigned_agent_id: string | null }[]
      | null
  }

  let swept = 0
  let nudged = 0
  for (const r of runs as Row[]) {
    const flowsField = Array.isArray(r.flows) ? r.flows[0] : r.flows
    const policy = resolveFallbackPolicy(flowsField?.fallback_policy ?? null)

    // Once a human owns the thread the bot must stay out of it. The run is
    // still `active` — the engine only advances on CUSTOMER messages, so an
    // agent hitting "Take over" and holding a full conversation leaves the
    // run exactly where it was. Without this the nudge fires 23h later and
    // interrupts the agent's own conversation, and the sweep then "hands
    // off" a thread that was handed off long ago.
    const conv = Array.isArray(r.conversations)
      ? r.conversations[0]
      : r.conversations
    const humanOwnsIt =
      Boolean(conv?.assigned_agent_id) || conv?.status === 'closed'
    const lastAdvanced = new Date(r.last_advanced_at)
    const ageHours = (now.getTime() - lastAdvanced.getTime()) / (1000 * 60 * 60)
    // ---- nudge, before the sweep ----
    //
    // One message after `nudge_hours` of silence, aimed at WhatsApp's 24-hour
    // customer service window: past 24h from the customer's last message a
    // free-form reply is refused and only a paid template gets through, so
    // this is the last free chance to recover the conversation.
    //
    // `last_advanced_at` is deliberately NOT touched — bumping it would push
    // the timeout out by a full cycle every nudge, and a customer who never
    // answers would never be swept.
    if (
      !humanOwnsIt &&
      policy.nudge_hours > 0 &&
      ageHours >= policy.nudge_hours &&
      ageHours < policy.on_timeout_hours &&
      r.conversation_id &&
      r.contact_id
    ) {
      // Idempotent by construction: the cron runs every few minutes, and a
      // customer sitting past 23h would otherwise be nudged on every pass.
      // `flow_run_events` has no 'nudge' value in its CHECK constraint, so
      // this rides on 'message_sent' with a payload marker rather than
      // needing a migration — it is, after all, a message sent.
      const { count: already } = await admin
        .from('flow_run_events')
        .select('id', { count: 'exact', head: true })
        .eq('flow_run_id', r.id)
        .eq('event_type', 'message_sent')
        .filter('payload->>kind', 'eq', 'nudge')

      if (!already) {
        try {
          await engineSendText({
            accountId: r.account_id,
            userId: r.user_id,
            conversationId: r.conversation_id,
            contactId: r.contact_id,
            text: policy.nudge_text,
          })
          await admin.from('flow_run_events').insert({
            flow_run_id: r.id,
            event_type: 'message_sent',
            node_key: r.current_node_key,
            payload: { kind: 'nudge', age_hours: Math.round(ageHours * 10) / 10 },
          })
          nudged += 1
        } catch (err) {
          // A failed nudge must not stop the sweep — the run still needs to
          // time out on schedule.
          console.error(
            '[flows-cron] nudge failed for run %s: %s',
            r.id,
            err instanceof Error ? err.message : err,
          )
        }
      }
    }

    if (ageHours < policy.on_timeout_hours) continue

    // A customer who goes quiet mid-flow is a warm lead, not litter. With
    // `on_timeout: 'handoff'` the sweep also flips the conversation to
    // pending so it surfaces in the inbox as needing a human, matching what
    // the fallback path already does when a reply doesn't match.
    const handoff =
      !humanOwnsIt &&
      policy.on_timeout === 'handoff' &&
      Boolean(r.conversation_id)

    // Mark timed_out — guarded by the precondition `status='active'`
    // so concurrent advance from a late inbound doesn't overwrite a
    // legitimate update.
    const { data: updated } = await admin
      .from('flow_runs')
      .update({
        status: handoff ? 'handed_off' : 'timed_out',
        ended_at: now.toISOString(),
        end_reason: handoff ? 'stale_sweep_handoff' : 'stale_sweep',
      })
      .eq('id', r.id)
      .eq('status', 'active')
      .select('id')

    if (Array.isArray(updated) && updated.length > 0) {
      // Only after the guarded update claimed the run — otherwise a late
      // inbound that legitimately advanced it would still get a conversation
      // yanked to pending underneath the running flow.
      if (handoff) {
        // Same path a handoff node takes — assigned, opened, AI silenced,
        // note in the banner. A customer who went quiet is still a lead.
        await handOffConversationToHuman({
          db: admin,
          accountId: r.account_id,
          conversationId: r.conversation_id,
          note: 'The customer stopped replying part-way through the bot flow.',
        })
      }
      await admin.from('flow_run_events').insert({
        flow_run_id: r.id,
        event_type: handoff ? 'handoff' : 'timeout',
        payload: {
          age_hours: Math.round(ageHours * 10) / 10,
          policy_hours: policy.on_timeout_hours,
          reason: handoff ? 'no_reply_handoff' : 'stale_sweep',
        },
      })
      swept += 1
    }
  }

  return NextResponse.json({ swept, nudged })
}
