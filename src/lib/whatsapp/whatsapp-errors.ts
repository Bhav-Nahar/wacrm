/**
 * Meta error codes in plain English.
 *
 * Meta's codes are opaque to anyone who has not memorised them — a user seeing
 * "131047" learns nothing, files a ticket, and waits. Mapping them at the edge is
 * the difference between a self-service explanation and a support conversation.
 */

export interface ErrorMeaning {
  message: string
  permanent: boolean
  billing?: boolean
  retryable?: boolean
  reauth?: boolean
}

const META_ERROR_CODES: Record<number, ErrorMeaning> = {
  // Authorisation. 190 is Meta's OAuthException: the tenant removed the app in
  // Business Settings, changed the owning account, or Meta invalidated the token.
  190: {
    message:
      "Access to your WhatsApp Business account has expired or was revoked in Meta Business Settings. Reconnect WhatsApp to start sending again.",
    permanent: false,
    reauth: true,
  },
  131026: {
    message: "This number isn't on WhatsApp, or can't receive messages.",
    permanent: true,
  },
  131047: {
    message:
      "More than 24 hours have passed since this customer last messaged, so only an approved template can be delivered.",
    permanent: true,
  },
  131049: {
    message:
      "Meta limited this message to protect the user experience. Try again later, or reduce message broadcast speed.",
    permanent: false,
    retryable: true,
  },
  131000: {
    message: "Something went wrong at Meta's end. It's worth retrying.",
    permanent: false,
    retryable: true,
  },
  // Billing. Codes observed for "no payment method / business not eligible to send paid messages"
  131042: {
    message:
      "WhatsApp can't send because there's no valid payment method on your WhatsApp Business Account. Add one in Meta Business Settings → WhatsApp Accounts → Payment settings, then try again.",
    permanent: false,
    billing: true,
  },
  131045: {
    message:
      "WhatsApp rejected the send for an account setup or certificate issue. Check your WhatsApp Business Account in Meta Business Settings.",
    permanent: false,
  },
  132000: {
    message:
      "The template's variables don't match what was approved — the message was rejected.",
    permanent: false,
  },
  132001: {
    message:
      "That template doesn't exist on this WhatsApp account, or isn't approved yet.",
    permanent: false,
  },
  132005: {
    message: "The template text is too long for one of its fields.",
    permanent: false,
  },
  132007: {
    message: "The template was rejected by Meta and can't be used.",
    permanent: false,
  },
  131031: {
    message:
      "This WhatsApp account has been restricted by Meta. Check WhatsApp Manager.",
    permanent: false,
  },
  131030: {
    message:
      "This recipient isn't on your test number's allowed list. Add and verify it in the Meta app dashboard, or connect a live WhatsApp account.",
    permanent: false,
  },
  130472: {
    message:
      "This user is in an experiment group that doesn't receive marketing messages.",
    permanent: true,
  },
  133004: {
    message:
      "WhatsApp account permissions were revoked. Please reconnect your account.",
    permanent: false,
    reauth: true,
  },
  133005: {
    message: "This phone number is already registered.",
    permanent: false,
  },
  133010: {
    message: "The phone number isn't registered for sending yet.",
    permanent: false,
  },
  368: {
    message:
      "Temporarily blocked for policy reasons — this usually follows too many blocks or reports from recipients.",
    permanent: false,
  },
}

const FALLBACK_ERROR: ErrorMeaning = {
  message: "WhatsApp could not deliver this message.",
  permanent: false,
}

/** Table lookup that reports "not one we know" instead of a generic sentence. */
function lookup(code: number | string | undefined | null): ErrorMeaning | null {
  if (code === undefined || code === null) return null
  const num = typeof code === 'string' ? parseInt(code, 10) : code
  if (isNaN(num)) return null
  return META_ERROR_CODES[num] ?? null
}

export function explainMetaError(code: number | string | undefined | null): ErrorMeaning {
  return lookup(code) ?? FALLBACK_ERROR
}

// Meta embeds its numeric code in the message it returns — "(#131047) Message
// failed to send because more than 24 hours…". Reading it back out of the text
// is what lets every call site use the table without meta-api.ts having to
// thread a code alongside every thrown Error.
const CODE_IN_TEXT = /\(#(\d+)\)/

/** Marker separating the explanation from Meta's original text. */
const RAW_MARKER = '(Meta: '

/**
 * Meta's raw error text, rewritten as something the reader can act on.
 *
 * Both halves are kept: the explanation first, then Meta's original in
 * parentheses. The explanation is for the customer staring at a failed
 * broadcast; the raw text is for whoever they forward it to. Dropping either
 * one costs somebody an hour.
 *
 * Returns `raw` unchanged when the code is unrecognised — a wrong explanation
 * is worse than none, and this string is shown verbatim in the UI.
 */
export function humanizeMetaError(
  raw: string,
  code?: number | string | null,
): string {
  // Idempotent: the result is persisted (broadcast_recipients.error_message),
  // so a retry that re-humanizes a stored string must not nest
  // "(Meta: … (Meta: …))".
  if (raw.includes(RAW_MARKER)) return raw

  const known = lookup(code) ?? lookup(raw.match(CODE_IN_TEXT)?.[1])
  if (known) return `${known.message} ${RAW_MARKER}${raw})`

  // No code to go on. The two account-level failures are worth catching from
  // the wording alone, because they are the ones that fail EVERY send until a
  // human changes something at Meta.
  if (isMetaBillingError(code, raw)) {
    return `${META_ERROR_CODES[131042].message} ${RAW_MARKER}${raw})`
  }
  if (isMetaReauthError(code, raw)) {
    return `${META_ERROR_CODES[190].message} ${RAW_MARKER}${raw})`
  }

  return raw
}

export function isMetaReauthError(code: number | string | undefined | null, text = ''): boolean {
  if (explainMetaError(code).reauth) return true
  const lower = text.toLowerCase()
  return (
    lower.includes('oauth') ||
    lower.includes('session has expired') ||
    lower.includes('invalid access token') ||
    lower.includes('error validating access token')
  )
}

export function isMetaBillingError(code: number | string | undefined | null, text = ''): boolean {
  if (explainMetaError(code).billing) return true
  const lower = text.toLowerCase()
  return (
    lower.includes('payment') ||
    lower.includes('billing') ||
    lower.includes('not eligible to send paid messages')
  )
}

export function isMetaPermanentError(code: number | string | undefined | null): boolean {
  return explainMetaError(code).permanent
}
