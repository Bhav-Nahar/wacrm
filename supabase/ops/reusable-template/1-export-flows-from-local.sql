-- ============================================================
-- STEP 1 of 2 — run this on LOCAL.
--
-- Dumps every flow in one account as a single JSON document you paste
-- into 2-import-flows-to-prod.sql.
--
-- Why JSON and not pg_dump / INSERT … SELECT: flows.user_id references
-- auth.users and flows.account_id references accounts. Those UUIDs are
-- local-only — prod has different users and a different account row —
-- so copying the rows verbatim fails on the foreign keys. Identity has
-- to be dropped here and re-resolved on the prod side.
--
-- Deliberately NOT exported:
--   id, account_id, user_id      — belong to the local install
--   execution_count,
--   last_executed_at             — local run history
--   status                       — the importer decides draft vs active
--   flow_runs, flow_run_events   — per-contact runtime state; local
--                                  conversations do not exist in prod
--
-- Run it:
--   docker exec -i supabase_db_wacrm psql -U postgres -d postgres -At \
--     < 1-export-flows-from-local.sql > flows.json
--
-- (-At = tuples only, unaligned: gives clean JSON with no header or
-- padding. Check the file is valid before moving on:
--   python3 -m json.tool flows.json > /dev/null && echo OK )
-- ============================================================

-- Which account? Pick ONE of the two WHERE clauses at the bottom.
-- To see your options first:
--   SELECT a.id, a.name, wc.phone_number_id
--   FROM accounts a LEFT JOIN whatsapp_config wc ON wc.account_id = a.id;

SELECT jsonb_pretty(
  jsonb_build_object(
    'exported_from', 'local',
    'account_name',  (SELECT name FROM accounts WHERE id = f.account_id),
    'flows', jsonb_agg(
      jsonb_build_object(
        'name',            f.name,
        'description',     f.description,
        'trigger_type',    f.trigger_type,
        'trigger_config',  f.trigger_config,
        'entry_node_id',   f.entry_node_id,
        'fallback_policy', f.fallback_policy,
        'source_status',   f.status,
        'nodes', COALESCE(
          (
            SELECT jsonb_agg(
                     jsonb_build_object(
                       'node_key',   n.node_key,
                       'node_type',  n.node_type,
                       'config',     n.config,
                       'position_x', n.position_x,
                       'position_y', n.position_y
                     )
                     -- set_tag nodes carry a `tag_id` UUID pointing at a
                     -- LOCAL tags row. That id does not exist in prod, so
                     -- the raw config alone would import a flow whose tag
                     -- nodes reference nothing. Carry the tag's NAME
                     -- alongside it and let the importer re-resolve.
                     || CASE
                          WHEN n.node_type = 'set_tag'
                               AND n.config ? 'tag_id'
                          THEN jsonb_build_object(
                                 'tag_name',
                                 (SELECT t.name FROM tags t
                                   WHERE t.id = (n.config->>'tag_id')::uuid)
                               )
                          ELSE '{}'::jsonb
                        END
                     ORDER BY n.node_key
                   )
            FROM flow_nodes n
            WHERE n.flow_id = f.id
          ),
          '[]'::jsonb
        )
      )
      ORDER BY f.created_at
    )
  )
)
FROM flows f

-- Option A — by account id (use this; local and prod phone_number_ids
-- are often different numbers):
WHERE f.account_id = '00000000-0000-0000-0000-000000000000'  -- EDIT

-- Option B — by the local WhatsApp number instead. Comment out A above
-- and uncomment this:
-- WHERE f.account_id = (
--   SELECT account_id FROM whatsapp_config
--   WHERE phone_number_id = '123456789012345'
-- )

-- Add this to export only the flows you actually finished:
--   AND f.status = 'active'

GROUP BY f.account_id;
