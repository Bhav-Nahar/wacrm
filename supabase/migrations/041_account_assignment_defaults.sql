-- ============================================================
-- accounts: account-wide defaults for conversation auto-assignment
--
-- Why this exists:
--   Round-robin settings lived only inside an individual automation's
--   `assign_conversation` step, three levels down a builder. An operator
--   asking "how does work get shared out across my team?" has no reason to
--   look there, and no way to answer it once for the whole account.
--
--   These columns are the account default. A step that specifies its own
--   roles / online-only still wins, so an automation can deliberately differ
--   (e.g. VIP enquiries to admins only) without changing the default.
--
-- NULL means "not configured" and the engine falls back to its own default
-- (everyone who can reply: owner, admin, agent). That is deliberately
-- distinct from an empty array — see the engine's handling — so an
-- untouched account keeps behaving exactly as it did before this migration.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS default_assignment_roles TEXT[],
  ADD COLUMN IF NOT EXISTS default_assignment_online_only BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN accounts.default_assignment_roles IS
  'Account roles eligible for round-robin assignment. NULL = not configured; the engine default (owner, admin, agent) applies.';

COMMENT ON COLUMN accounts.default_assignment_online_only IS
  'When true, round-robin skips members whose presence heartbeat has gone stale.';

-- Guard against junk roles reaching the engine. `viewer` is rejected too:
-- a viewer cannot reply, so assigning them a conversation parks it.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_default_assignment_roles_valid;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_default_assignment_roles_valid
  CHECK (
    default_assignment_roles IS NULL
    OR default_assignment_roles <@ ARRAY['owner', 'admin', 'agent']::TEXT[]
  );
