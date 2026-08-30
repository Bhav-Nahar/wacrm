-- ============================================================
-- conversations.last_message_from — "who spoke last?"
--
-- Why this exists:
--   The inbox could show that a thread had unread messages, but not
--   that it was still *waiting on us*. Opening a conversation zeroes
--   `unread_count` — so a thread an agent read and then forgot to
--   answer looks identical to one that is fully handled. That is
--   exactly the thread that loses the sale.
--
--   `last_message_from` records the sender_type of the newest message,
--   so "customer spoke last" survives being read. The inbox turns that
--   into an elapsed-time badge and a "Waiting" filter.
--
-- Kept in sync by a trigger on `messages`, NOT by application code:
--   six different call sites write conversations.last_message_text
--   (webhook RPC, /api/whatsapp/send, flows, automations, public API),
--   and every future one would have to remember. Every one of them
--   inserts into `messages` first, so the trigger is the one place
--   that cannot be forgotten.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_message_from TEXT
    CHECK (last_message_from IN ('customer', 'agent', 'bot'));

COMMENT ON COLUMN conversations.last_message_from IS
  'sender_type of the newest message. ''customer'' = waiting on us. Maintained by trg_conversation_last_message_from; do not write from application code.';

CREATE OR REPLACE FUNCTION public.set_conversation_last_message_from()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- The IS DISTINCT FROM guard keeps a burst of same-side messages
  -- (a customer sending five lines in a row) from firing five
  -- pointless UPDATEs — each of which is a realtime event to every
  -- connected inbox.
  UPDATE conversations
  SET last_message_from = NEW.sender_type
  WHERE id = NEW.conversation_id
    AND last_message_from IS DISTINCT FROM NEW.sender_type;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversation_last_message_from ON messages;
CREATE TRIGGER trg_conversation_last_message_from
AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION public.set_conversation_last_message_from();

-- Backfill from the newest existing message per conversation.
UPDATE conversations c
SET last_message_from = m.sender_type
FROM (
  SELECT DISTINCT ON (conversation_id)
         conversation_id, sender_type
  FROM messages
  ORDER BY conversation_id, created_at DESC, id DESC
) m
WHERE m.conversation_id = c.id
  AND c.last_message_from IS DISTINCT FROM m.sender_type;
