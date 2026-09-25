/**
 * Relay Meta webhook deliveries that belong to another app on the same Meta
 * app (Pinzo / gmb-mvp).
 *
 * Meta allows ONE callback URL per app, and it points here. Numbers onboarded
 * through Pinzo send their events to us too; we have no whatsapp_config row
 * for them, so without this relay their delivery receipts, replies and
 * opt-outs are silently lost.
 *
 * The raw body and Meta's `x-hub-signature-256` are forwarded byte-for-byte.
 * Both apps share the Meta app secret, so the receiver verifies the relayed
 * request exactly as if Meta had sent it, and needs no knowledge of us.
 * A payload is forwarded whole (it can't be split without breaking the
 * signature); the receiver ignores entries for numbers it doesn't own, just
 * as we do.
 *
 * Unset WHATSAPP_WEBHOOK_FORWARD_URL = no relay, behaviour unchanged.
 */

interface Entry {
  id?: string
  changes?: Array<{ value?: { metadata?: { phone_number_id?: string } } }>
}

/**
 * True when any change in the payload is for a number (or, for number-less
 * events like template / quality / user_preferences, a WABA) we don't own.
 */
export function needsForward(
  body: { entry?: Entry[] },
  ownedPhoneIds: Set<string>,
  ownedWabaIds: Set<string>,
): boolean {
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const phoneId = change.value?.metadata?.phone_number_id
      if (phoneId) {
        if (!ownedPhoneIds.has(String(phoneId))) return true
      } else if (entry.id && !ownedWabaIds.has(String(entry.id))) {
        return true
      }
    }
  }
  return false
}

export async function forwardWebhook(
  url: string,
  rawBody: string,
  signature: string | null,
): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'x-hub-signature-256': signature } : {}),
      },
      body: rawBody,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      console.error('[webhook-forward] receiver answered', res.status)
    }
  } catch (err) {
    // Best-effort, like the rest of after(): Meta already has its 200, and a
    // relay failure must not affect our own processing.
    console.error(
      '[webhook-forward] relay failed:',
      err instanceof Error ? err.message : err,
    )
  }
}
