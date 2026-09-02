-- ============================================================
-- Prove send_form in PROD, without disturbing anything real.
--
-- Creates a throwaway 'Form test' flow triggered by the EXACT keyword
-- 'formtest'. No real customer sends that word, so the flow is
-- invisible to them even while active. Nothing else in the account is
-- touched.
--
-- PREREQUISITES, in this order:
--   1. Migration 043_flow_send_form.sql applied here (checked below)
--   2. The app deployed with the send_form code — the DB accepting the
--      node is not enough, the runner has to know how to send it
--   3. A PUBLISHED Meta Flow on the SAME WABA as this account's number.
--      A Flow from another WABA fails with Meta's "does not exist,
--      cannot be loaded due to missing permissions".
--
-- Run in the Supabase SQL Editor. Teardown is at the bottom.
-- ============================================================

DO $$
DECLARE
  -- ---------- EDIT THESE ----------
  target_account_id UUID := '15fb3ff7-fe68-4241-ab51-fef22a78ced2';
  -- Meta Flow Builder → your published Flow's ID. Numeric, not a UUID.
  meta_flow_id      TEXT := 'REPLACE_ME';
  -- The `id` of the FIRST screen in the Flow JSON's `screens` array,
  -- e.g. 'WELCOME'.
  screen_id         TEXT := 'REPLACE_ME';
  -- --------------------------------

  v_flow_id  UUID;
  v_user_id  UUID;
BEGIN
  IF meta_flow_id = 'REPLACE_ME' OR screen_id = 'REPLACE_ME' THEN
    RAISE EXCEPTION 'Set meta_flow_id and screen_id first.';
  END IF;
  IF meta_flow_id ~ '-' THEN
    RAISE EXCEPTION
      'meta_flow_id "%" looks like a UUID. Meta Flow IDs are numeric.',
      meta_flow_id;
  END IF;

  -- Refuse rather than fail mid-insert on a CHECK violation.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'flow_nodes_node_type_check'
      AND pg_get_constraintdef(oid) LIKE '%send_form%'
  ) THEN
    RAISE EXCEPTION
      'Migration 043_flow_send_form.sql is not applied on this database. Apply it first.';
  END IF;

  SELECT owner_user_id INTO v_user_id
  FROM accounts WHERE id = target_account_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No account has id %.', target_account_id;
  END IF;

  -- Re-runnable: drop any previous attempt. Nodes cascade.
  DELETE FROM flows
  WHERE account_id = target_account_id AND name = 'Form test';

  INSERT INTO flows (
    user_id, account_id, name, description, status,
    trigger_type, trigger_config, entry_node_id
  )
  VALUES (
    v_user_id, target_account_id,
    'Form test',
    'Throwaway — proves the send_form node. Delete when done.',
    'active',
    'keyword',
    -- EXACT match on a word no customer types. This is what makes an
    -- active test flow safe to leave sitting in a live account.
    '{"keywords":["formtest"],"match_type":"exact"}'::jsonb,
    'start'
  )
  RETURNING id INTO v_flow_id;

  INSERT INTO flow_nodes (flow_id, node_key, node_type, config, position_x, position_y)
  VALUES
    (v_flow_id, 'start', 'start',
     '{"next_node_key":"greet"}'::jsonb, 0, 0),
    (v_flow_id, 'greet', 'send_message',
     '{"text":"Form test. Tap the button below and submit the form.","next_node_key":"ask_form"}'::jsonb, 0, 120),
    (v_flow_id, 'ask_form', 'send_form',
     jsonb_build_object(
       'body_text',     'Please fill in your details.',
       'meta_flow_id',  meta_flow_id,
       'cta_label',     'Open form',
       'screen_id',     screen_id,
       -- Prefix proves the var-namespacing works; fields land as f_<name>.
       'var_prefix',    'f_',
       'next_node_key', 'echo'
     ), 0, 240),
    (v_flow_id, 'echo', 'send_message',
     '{"text":"Got it — form received, and the flow moved on. ✅","next_node_key":"fin"}'::jsonb, 0, 360),
    (v_flow_id, 'fin', 'end', '{}'::jsonb, 0, 480);

  RAISE NOTICE 'Form test created and ACTIVE as %. Send "formtest" from WhatsApp.', v_flow_id;
END $$;


-- ============================================================
-- VERIFY — after you submit the form
-- ============================================================
-- `vars` should hold one f_-prefixed key per form field, and Meta's
-- echoed flow_token must NOT be among them.
--
-- SELECT r.status, r.current_node_key, r.ended_at, jsonb_pretty(r.vars) AS captured
-- FROM flow_runs r JOIN flows f ON f.id = r.flow_id
-- WHERE f.name = 'Form test'
-- ORDER BY r.started_at DESC LIMIT 1;


-- ============================================================
-- TRACE — if nothing comes back
-- ============================================================
-- Expect, in order: message_sent (node_type send_form) = we sent it;
-- reply_received with a form_fields array = Meta delivered the
-- submission; node_entered with captured_keys = it reached vars.
-- Only the first means the send worked but the reply never arrived.
--
-- SELECT e.created_at, e.event_type, e.node_key, jsonb_pretty(e.payload)
-- FROM flow_run_events e
-- JOIN flow_runs r ON r.id = e.flow_run_id
-- JOIN flows f ON f.id = r.flow_id
-- WHERE f.name = 'Form test'
-- ORDER BY e.created_at DESC LIMIT 20;


-- ============================================================
-- TEARDOWN — do this when the test passes
-- ============================================================
-- Leaving an active test flow in a live account is how a "temporary"
-- thing becomes permanent.
--
-- DELETE FROM flows
-- WHERE account_id = '15fb3ff7-fe68-4241-ab51-fef22a78ced2'
--   AND name = 'Form test';
