-- ============================================================
-- Finishing the send_form end-to-end test.
--
-- Migration 043 is applied locally and the 'Form test' flow exists as
-- a DRAFT with placeholder Meta ids. This file is the last two steps,
-- to run once you have the Flow ID and entry screen from Meta.
--
-- Run against LOCAL:
--   docker exec -i supabase_db_wacrm psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < finish-send-form-test.sql
-- ============================================================


-- ============================================================
-- STEP 1 — drop in the real Meta ids and activate the flow
-- ============================================================
DO $$
DECLARE
  -- ---------- EDIT THESE TWO ----------
  -- From Meta Flow Builder: the published Flow's ID (numeric string).
  meta_flow_id TEXT := 'REPLACE_ME';
  -- The id of the Flow's FIRST screen, e.g. 'WELCOME' or 'SCREEN_ONE'.
  -- It is the `id` of the first entry in the Flow JSON's `screens` array.
  screen_id    TEXT := 'REPLACE_ME';
  -- ------------------------------------

  v_flow_id CONSTANT UUID := '0f000000-0000-4000-8000-00000000f001';
BEGIN
  IF meta_flow_id = 'REPLACE_ME' OR screen_id = 'REPLACE_ME' THEN
    RAISE EXCEPTION
      'Set meta_flow_id and screen_id first — both still say REPLACE_ME.';
  END IF;
  -- A UUID here means the accounts.id / phone_number_id mix-up again:
  -- a Meta Flow ID is a digit string.
  IF meta_flow_id ~ '-' THEN
    RAISE EXCEPTION
      'meta_flow_id "%" looks like a UUID. Meta Flow IDs are numeric.',
      meta_flow_id;
  END IF;

  UPDATE flow_nodes
  SET config = config
      || jsonb_build_object('meta_flow_id', meta_flow_id)
      || jsonb_build_object('screen_id', screen_id)
  WHERE flow_nodes.flow_id = v_flow_id
    AND node_key = 'ask_form';

  -- The runner only loads flows with status='active'.
  UPDATE flows SET status = 'active' WHERE id = v_flow_id;

  RAISE NOTICE 'Form test is live: flow % / screen %', meta_flow_id, screen_id;
END $$;


-- ============================================================
-- STEP 2 — clear this contact's runs so 'formtest' starts fresh
-- ============================================================
-- Only one ACTIVE run is allowed per contact, and an existing one
-- swallows 'formtest' as a reply instead of firing the trigger.
-- EDIT the phone fragment.
--
-- DELETE FROM flow_runs
-- WHERE contact_id = (
--   SELECT id FROM contacts WHERE phone LIKE '%<your test number>%'
-- );


-- ============================================================
-- STEP 3 — after submitting the form, check what was captured
-- ============================================================
-- The real proof. `vars` should hold one prefixed key per form field
-- (var_prefix is 'f_', so a field named `email` lands as `f_email`),
-- and Meta's echoed flow_token must NOT appear as a var.
--
-- SELECT r.status, r.current_node_key, jsonb_pretty(r.vars) AS captured
-- FROM flow_runs r
-- JOIN flows f ON f.id = r.flow_id
-- WHERE f.name = 'Form test'
-- ORDER BY r.started_at DESC
-- LIMIT 1;


-- ============================================================
-- STEP 4 — the event trail, if something went wrong
-- ============================================================
-- Look for: message_sent with node_type 'send_form' (we sent it), then
-- reply_received with a form_fields array (Meta delivered the
-- submission), then node_entered with captured_keys.
--
-- SELECT e.created_at, e.event_type, e.node_key, jsonb_pretty(e.payload)
-- FROM flow_run_events e
-- JOIN flow_runs r ON r.id = e.flow_run_id
-- JOIN flows f ON f.id = r.flow_id
-- WHERE f.name = 'Form test'
-- ORDER BY e.created_at DESC
-- LIMIT 20;


-- ============================================================
-- TEARDOWN — when the test is done
-- ============================================================
-- DELETE FROM flows WHERE name = 'Form test';   -- nodes cascade
