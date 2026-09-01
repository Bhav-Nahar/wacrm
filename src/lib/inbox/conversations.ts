import type { Conversation, Contact, Tag } from "@/types";

/**
 * Conversation select that embeds the contact plus its tags, so the Inbox
 * can filter conversations by contact tag without a second round-trip.
 * `contact_tags(tags(*))` returns the join rows; {@link normalizeConversation}
 * flattens them onto `contact.tags`.
 */
export const CONVERSATION_SELECT =
  "*, contact:contacts(*, contact_tags(tags(*))), flow_runs(status)";

/** Raw shape returned by {@link CONVERSATION_SELECT} before flattening. */
type RawContact = Contact & { contact_tags?: { tags: Tag | null }[] };
type RawConversation = Omit<Conversation, "contact"> & {
  contact?: RawContact | null;
  flow_runs?: { status: string }[] | null;
};

/**
 * Flatten the embedded `contact_tags(tags(*))` join into `contact.tags`.
 * Safe to call on rows fetched with {@link CONVERSATION_SELECT}; a row with
 * no contact (e.g. a freshly-inserted conversation) passes through untouched.
 */
export function normalizeConversation(raw: RawConversation): Conversation {
  // A live flow run is what "a bot is driving this" actually means — there is
  // no `bot` conversation status, and adding one would duplicate this fact in
  // a second place that can drift out of sync when a run ends or is swept.
  // Derived on read instead, so it disappears on its own.
  const { flow_runs, ...rest } = raw;
  const bot_active = (flow_runs ?? []).some((r) => r.status === "active");

  const rawContact = rest.contact;
  if (!rawContact) return { ...rest, bot_active } as Conversation;

  const { contact_tags, ...contact } = rawContact;
  return {
    ...rest,
    bot_active,
    contact: {
      ...contact,
      tags: (contact_tags ?? [])
        .map((ct) => ct.tags)
        .filter((t): t is Tag => t != null),
    },
  };
}

export function normalizeConversations(
  rows: RawConversation[],
): Conversation[] {
  return rows.map(normalizeConversation);
}

export interface ContactFilters {
  /** Tag ids; a conversation matches if its contact has ANY of them (OR). */
  tagIds: string[];
  /** Exact company match, or null for no company filter. */
  company: string | null;
}

/**
 * Whether a conversation passes the contact-based Inbox filters (issue #272).
 * Empty `tagIds` and null `company` are no-ops, so the default (no filters)
 * always matches. Tags use OR logic, consistent with Broadcast audiences.
 */
export function matchesContactFilters(
  conversation: Conversation,
  { tagIds, company }: ContactFilters,
): boolean {
  if (tagIds.length > 0) {
    const contactTagIds = conversation.contact?.tags ?? [];
    if (!contactTagIds.some((t) => tagIds.includes(t.id))) return false;
  }

  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  return true;
}

/**
 * Whether the customer spoke last and is still waiting on a reply.
 *
 * Deliberately NOT `unread_count > 0`: opening a thread zeroes the
 * unread count, so a message an agent read and then forgot to answer
 * would look handled. `last_message_from` survives being read — that
 * gap is the whole point of the "Waiting" filter.
 *
 * Closed threads are excluded: someone decided they were done, and a
 * customer's "thanks!" shouldn't drag them back into the queue.
 */
export function isWaitingOnUs(conversation: Conversation): boolean {
  return (
    conversation.last_message_from === "customer" &&
    conversation.status !== "closed"
  );
}
