-- ============================================================
-- STEP 2 of 2 — run this on PROD (Supabase dashboard → SQL Editor).
--
-- Takes the JSON from step 1, resolves the destination account from
-- its WhatsApp number, and recreates every flow + node with fresh ids
-- owned by prod's own account and user.
--
-- BEFORE RUNNING, prod needs the migrations the flows depend on:
--   042_conversation_last_message_from.sql
--   043_flow_send_form.sql   (only if any flow uses a send_form node —
--                             the preflight below checks for you)
--
-- Re-runnable: a flow whose name already exists in the destination
-- account is SKIPPED, not duplicated. Rename or delete the existing one
-- if you meant to replace it.
-- ============================================================

DO $$
DECLARE
  -- ---------- EDIT THIS SECTION ----------
  -- Paste the whole contents of flows.json between the $json$ markers.
  -- Dollar-quoting means you do NOT need to escape the quotes inside.
  payload    JSONB := $json$
{
  "exported_from": "local",
  "flows": []
}
  $json$::jsonb;

  -- Identify the destination account by EITHER of these. Set one and
  -- leave the other alone; target_account_id wins if both are set.
  --
  --   SELECT id, name FROM accounts;                      -- for the UUID
  --   SELECT phone_number_id, account_id FROM whatsapp_config;  -- for the PNI
  --
  -- A) The account's UUID, if you already have it. Most direct.
  target_account_id UUID := NULL;
  --    e.g. target_account_id UUID := '15fb3ff7-fe68-4241-ab51-fef22a78ced2';
  --
  -- B) Or Meta's phone_number_id — a 15-16 digit NUMBER, not a UUID.
  --    Only used when target_account_id above is NULL.
  target_pni TEXT    := '123456789012345';

  -- FALSE imports as drafts so you can open each one in the builder and
  -- activate deliberately. TRUE makes every imported flow live the
  -- moment this commits — it will start answering real customers.
  go_live    BOOLEAN := FALSE;
  -- --------------------------------------

  tgt_account  UUID;
  tgt_user     UUID;
  tgt_tag      UUID;
  f            JSONB;
  n            JSONB;
  node_config  JSONB;
  new_flow     UUID;
  imported     INT := 0;
  skipped      INT := 0;
  node_total   INT := 0;
  tags_created INT := 0;
BEGIN
  -- 1. Resolve the destination account + owner from the number.
  --
  -- Owner comes from accounts.owner_user_id (NOT NULL) rather than
  -- profiles.account_role, which is nullable and can be unset.
  -- flows.user_id only feeds audit columns on outbound sends; the
  -- runner loads flows by account_id.
  IF target_account_id IS NOT NULL THEN
    -- Straight from accounts — no WhatsApp config needed, so this also
    -- works on an account whose number is not connected yet.
    SELECT a.id, a.owner_user_id
      INTO tgt_account, tgt_user
    FROM accounts a
    WHERE a.id = target_account_id;

    IF tgt_account IS NULL THEN
      RAISE EXCEPTION
        'No account has id %. Check it with: SELECT id, name FROM accounts;',
        target_account_id;
    END IF;
  ELSE
    SELECT wc.account_id, a.owner_user_id
      INTO tgt_account, tgt_user
    FROM whatsapp_config wc
    JOIN accounts a ON a.id = wc.account_id
    WHERE wc.phone_number_id = target_pni;

    IF tgt_account IS NULL THEN
      RAISE EXCEPTION
        'No whatsapp_config row has phone_number_id % joined to an account. Note this must be Meta''s 15-16 digit phone_number_id, NOT an account UUID — if you have the UUID, set target_account_id instead.',
        target_pni;
    END IF;
  END IF;

  IF payload->'flows' IS NULL
     OR jsonb_array_length(payload->'flows') = 0 THEN
    RAISE EXCEPTION
      'The payload has no flows — did the export land in the file, and did you paste it between the $json$ markers?';
  END IF;

  -- 2. Preflight: fail with a readable message rather than a raw CHECK
  --    violation halfway through the import.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(payload->'flows') fl,
         jsonb_array_elements(fl->'nodes') nd
    WHERE nd->>'node_type' = 'send_form'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'flow_nodes_node_type_check'
      AND pg_get_constraintdef(oid) LIKE '%send_form%'
  ) THEN
    RAISE EXCEPTION
      'A flow uses a send_form node but this database has not had migration 043_flow_send_form.sql applied. Apply it, then re-run.';
  END IF;

  -- 3. Import.
  FOR f IN SELECT * FROM jsonb_array_elements(payload->'flows')
  LOOP
    IF EXISTS (
      SELECT 1 FROM flows
      WHERE account_id = tgt_account
        AND name = f->>'name'
    ) THEN
      RAISE NOTICE 'SKIP "%" — a flow with that name already exists in this account.',
        f->>'name';
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO flows (
      user_id, account_id, name, description, status,
      trigger_type, trigger_config, entry_node_id, fallback_policy
    )
    VALUES (
      tgt_user,
      tgt_account,
      f->>'name',
      f->>'description',
      CASE WHEN go_live THEN 'active' ELSE 'draft' END,
      f->>'trigger_type',
      COALESCE(f->'trigger_config', '{}'::jsonb),
      f->>'entry_node_id',
      COALESCE(
        f->'fallback_policy',
        '{"on_unknown_reply":"reprompt","max_reprompts":2,"on_timeout_hours":24,"on_exhaust":"handoff"}'::jsonb
      )
    )
    RETURNING id INTO new_flow;

    -- node_key values carry across verbatim. Every edge references them
    -- by name — next_node_key, each button's and list row's target,
    -- condition true_next/false_next, and flows.entry_node_id — so
    -- nothing needs rewriting to point at the new flow's nodes.
    --
    -- `tag_id` is the ONE exception: it is a real UUID into `tags`, and
    -- the source database's ids mean nothing here. Re-resolve by name.
    FOR n IN SELECT * FROM jsonb_array_elements(f->'nodes')
    LOOP
      node_config := COALESCE(n->'config', '{}'::jsonb);

      IF n->>'node_type' = 'set_tag' AND n->>'tag_name' IS NOT NULL THEN
        SELECT id INTO tgt_tag
        FROM tags
        WHERE account_id = tgt_account
          AND lower(name) = lower(n->>'tag_name')
        LIMIT 1;

        -- Create the tag rather than importing a broken node. A flow
        -- that tags "Qualified lead" is useless if the tag is missing,
        -- and the alternative — failing the whole import — makes the
        -- user hand-create tags before retrying for no reason.
        IF tgt_tag IS NULL THEN
          INSERT INTO tags (user_id, account_id, name)
          VALUES (tgt_user, tgt_account, n->>'tag_name')
          RETURNING id INTO tgt_tag;
          tags_created := tags_created + 1;
          RAISE NOTICE '  created tag "%" as %', n->>'tag_name', tgt_tag;
        END IF;

        node_config := jsonb_set(
          node_config, '{tag_id}', to_jsonb(tgt_tag::text)
        );
      END IF;

      INSERT INTO flow_nodes (
        flow_id, node_key, node_type, config, position_x, position_y
      )
      VALUES (
        new_flow,
        n->>'node_key',
        n->>'node_type',
        node_config,
        COALESCE((n->>'position_x')::INT, 0),
        COALESCE((n->>'position_y')::INT, 0)
      );
      node_total := node_total + 1;
    END LOOP;

    imported := imported + 1;
    RAISE NOTICE 'imported "%" as % (% nodes)',
      f->>'name', new_flow,
      jsonb_array_length(COALESCE(f->'nodes', '[]'::jsonb));
  END LOOP;

  RAISE NOTICE
    'Done. % flow(s) imported, % skipped, % node(s), % tag(s) created, into account % as %.',
    imported, skipped, node_total, tags_created, tgt_account,
    CASE WHEN go_live THEN 'ACTIVE' ELSE 'draft' END;
END $$;


-- ============================================================
-- VERIFY (run separately, after the block above)
-- ============================================================
-- SELECT f.name, f.status, f.trigger_type, f.entry_node_id,
--        COUNT(n.id) AS nodes
-- FROM flows f
-- LEFT JOIN flow_nodes n ON n.flow_id = f.id
-- WHERE f.account_id = (
--   SELECT account_id FROM whatsapp_config
--   WHERE phone_number_id = '123456789012345'
-- )
-- GROUP BY f.id, f.name, f.status, f.trigger_type, f.entry_node_id
-- ORDER BY f.created_at DESC;
--
-- Every flow should show entry_node_id matching one of its node_keys.
-- If a flow shows 0 nodes, the import inserted the row but the nodes
-- array was empty in the export — re-check step 1.
