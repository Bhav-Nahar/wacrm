import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { markMessageRead } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * POST /api/whatsapp/read
 *
 * Body: { conversation_id: <UUID> }
 *
 * Sends a read receipt (blue ticks) to Meta for the newest inbound
 * message in the conversation. Meta marks that message and everything
 * before it as read, so one call per thread-open is enough.
 *
 * Fire-and-forget from the inbox: the caller ignores the response. A
 * failure here must never block reading a thread, so every "nothing to
 * do" case returns 200 with `{ marked: false }` rather than an error —
 * the client has no remedy for any of them.
 */
export async function POST(request: Request) {
  try {
    // `agent` and not a read-only viewer: a read receipt is visible to
    // the customer, which makes it a write to the outside world even
    // though nothing changes in our DB.
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`read:${userId}`, RATE_LIMITS.react);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const conversationId = body?.conversation_id;
    if (typeof conversationId !== 'string' || !conversationId) {
      return NextResponse.json(
        { error: 'conversation_id is required' },
        { status: 400 },
      );
    }

    // Ownership check — RLS would hide a foreign row anyway, the
    // explicit account_id filter makes that intent readable.
    const { data: conversation } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 },
      );
    }

    // Newest inbound message that Meta actually knows about. Agent and
    // bot messages are excluded (you can't mark your own message read)
    // and so are rows with no wamid (a send that never left).
    const { data: inbound } = await supabase
      .from('messages')
      .select('message_id')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .not('message_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!inbound?.message_id) {
      return NextResponse.json({ marked: false });
    }

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', accountId)
      .single();

    if (!config) return NextResponse.json({ marked: false });

    try {
      await markMessageRead({
        phoneNumberId: config.phone_number_id,
        accessToken: decrypt(config.access_token),
        messageId: inbound.message_id,
      });
    } catch (err) {
      // Meta rejects receipts for messages older than 30 days, and for
      // ones already marked read. Neither is worth surfacing to an
      // agent who just clicked a thread.
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.warn('[whatsapp/read] Meta rejected the receipt:', message);
      return NextResponse.json({ marked: false });
    }

    return NextResponse.json({ marked: true });
  } catch (error) {
    console.error('Error in WhatsApp read POST:', error);
    return toErrorResponse(error);
  }
}
