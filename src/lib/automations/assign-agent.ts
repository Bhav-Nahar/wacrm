// ============================================================
// Round-robin assignee selection for the `assign_conversation` step.
//
// Split out of engine.ts because this is the only part of that step with
// real branching — role eligibility, presence, and load — and it deserves
// tests that don't need the whole automation harness stood up.
//
// Strategy: fewest OPEN conversations wins.
//
//   Deliberately not a strict A→B→C rotation, which would need a stored
//   cursor and a migration. Counting live conversations self-balances with
//   no state at all: three members on zero, the first goes to A, and now A
//   has one so the next goes to B. It also adapts when someone is slower or
//   away, which strict rotation cannot — that keeps handing work to whoever
//   is already buried.
//
//   A tie only survives until the first assignment breaks it, so the
//   deterministic tiebreak below does not concentrate work.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { AccountRole } from '@/lib/auth/roles'
import { derivePresence, type StoredPresence } from '@/lib/presence'
import type { AssignConversationStepConfig } from '@/types'

/**
 * Who can be auto-assigned when a config doesn't say.
 *
 * Everyone who can actually reply. `viewer` is excluded: assigning a
 * conversation to someone who cannot answer it parks the conversation.
 */
export const DEFAULT_ASSIGNABLE_ROLES: AccountRole[] = [
  'owner',
  'admin',
  'agent',
]

interface ProfileRow {
  user_id: string
  account_role: AccountRole | null
}

interface PresenceLookupRow {
  user_id: string
  status: StoredPresence
  last_seen_at: string
}

/**
 * Choose the least-loaded eligible member, or undefined when nobody qualifies.
 *
 * Returning undefined is a legitimate outcome, not a failure: the caller
 * leaves the conversation unassigned, and an unassigned conversation is still
 * visible to the whole team in the shared inbox. That is strictly better than
 * assigning it to someone who logged off on Friday.
 *
 * `now` is injected so presence derivation is deterministic under test.
 */
export async function pickRoundRobinAgent(
  db: SupabaseClient,
  accountId: string,
  cfg: Pick<AssignConversationStepConfig, 'roles' | 'online_only'>,
  now: number = Date.now(),
): Promise<string | undefined> {
  // Precedence: the step's own config, then the account default set in
  // Settings → Team & assignment, then the built-in default. A step that says
  // nothing inherits the account's answer, so an operator can configure this
  // once instead of per automation.
  let roles = cfg.roles && cfg.roles.length > 0 ? cfg.roles : undefined
  let onlineOnly = cfg.online_only

  if (roles === undefined || onlineOnly === undefined) {
    const { data: account } = await db
      .from('accounts')
      .select('default_assignment_roles, default_assignment_online_only')
      .eq('id', accountId)
      .maybeSingle()

    const defaults = account as {
      default_assignment_roles: AccountRole[] | null
      default_assignment_online_only: boolean | null
    } | null

    if (roles === undefined && defaults?.default_assignment_roles?.length) {
      roles = defaults.default_assignment_roles
    }
    if (onlineOnly === undefined) {
      onlineOnly = defaults?.default_assignment_online_only ?? false
    }
  }

  roles = roles ?? DEFAULT_ASSIGNABLE_ROLES

  const { data: profiles } = await db
    .from('profiles')
    .select('user_id, account_role')
    .eq('account_id', accountId)
    .in('account_role', roles)

  let candidates = ((profiles ?? []) as ProfileRow[])
    .map((p) => p.user_id)
    .filter(Boolean)

  if (candidates.length === 0) return undefined

  if (onlineOnly) {
    const { data: presence } = await db
      .from('member_presence')
      .select('user_id, status, last_seen_at')
      .eq('account_id', accountId)

    // One definition of "offline" for the whole app — the same helper the
    // roster and the inbox Assign dropdown use, so what an automation
    // considers reachable matches what a human sees on screen.
    const reachable = new Set(
      ((presence ?? []) as PresenceLookupRow[])
        .filter(
          (row) => derivePresence(row.status, row.last_seen_at, now) !== 'offline',
        )
        .map((row) => row.user_id),
    )

    candidates = candidates.filter((id) => reachable.has(id))
    if (candidates.length === 0) return undefined
  }

  // ponytail: counts open conversations client-side rather than via a
  // GROUP BY, which keeps this migration-free. Fine into the low thousands
  // of open conversations; past that, move the tally into an RPC.
  const { data: open } = await db
    .from('conversations')
    .select('assigned_agent_id')
    .eq('account_id', accountId)
    .neq('status', 'closed')
    .not('assigned_agent_id', 'is', null)

  const load = new Map<string, number>(candidates.map((id) => [id, 0]))
  for (const row of (open ?? []) as { assigned_agent_id: string | null }[]) {
    const id = row.assigned_agent_id
    // Conversations held by someone no longer eligible (role changed, left the
    // account) are ignored rather than counted — their load is not a reason to
    // skip anyone who IS eligible.
    if (id && load.has(id)) load.set(id, load.get(id)! + 1)
  }

  // Sort by load, then by id — a stable, deterministic pick so the same state
  // always produces the same choice and the tests aren't flaky.
  return [...load.entries()].sort(
    (a, b) => a[1] - b[1] || a[0].localeCompare(b[0]),
  )[0][0]
}
