-- ============================================================
-- 043_flow_send_form.sql
--
-- Adds the 'send_form' node type: a native WhatsApp Flow (Meta's
-- in-app form sheet) sent as one message instead of a chain of
-- collect_input prompts.
--
-- Why no `whatsapp_forms` table:
--   Every other node keeps its configuration in `flow_nodes.config`
--   JSONB, shape-checked by the TS types + validator rather than the
--   DB. A form node needs exactly three extra strings — the published
--   Flow's id, its entry screen, and the button label — so a registry
--   table would buy nothing but RLS, routes, and a settings screen.
--   Reusing one form across several flows means pasting the id again;
--   that is the whole cost, and it is cheaper than the table.
--
--   If forms ever need server-side state (a data_exchange endpoint,
--   RSA key rotation, per-form submission analytics) that is the
--   moment to promote them to their own table.
--
-- Mirrors migration 016's drop-and-recreate of the CHECK constraint.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'send_form',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'end'
  ));
