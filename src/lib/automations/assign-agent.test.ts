import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  DEFAULT_ASSIGNABLE_ROLES,
  pickRoundRobinAgent,
} from './assign-agent'
import { OFFLINE_AFTER_MS } from '@/lib/presence'
import type { AccountRole } from '@/lib/auth/roles'

const NOW = 1_800_000_000_000

interface Member {
  user_id: string
  account_role: AccountRole
  /** ms since this member last heartbeat. Omitted = no presence row at all. */
  lastSeenAgoMs?: number
  status?: 'online' | 'away'
}

/**
 * Minimal Supabase stand-in covering exactly the three reads the picker makes.
 * Records the role filter so tests can assert on eligibility without reaching
 * into the implementation.
 */
function makeDb(opts: {
  members: Member[]
  /** assigned_agent_id for every non-closed conversation. */
  openAssignments?: (string | null)[]
  /** Account-level defaults from Settings -> Team & assignment. */
  accountDefaults?: {
    default_assignment_roles: AccountRole[] | null
    default_assignment_online_only: boolean | null
  } | null
}) {
  const captured: { roles?: AccountRole[] } = {}

  const db = {
    from(table: string) {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              in: (_col: string, roles: AccountRole[]) => {
                captured.roles = roles
                return Promise.resolve({
                  data: opts.members
                    .filter((m) => roles.includes(m.account_role))
                    .map((m) => ({
                      user_id: m.user_id,
                      account_role: m.account_role,
                    })),
                  error: null,
                })
              },
            }),
          }),
        }
      }

      if (table === 'accounts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: opts.accountDefaults ?? null,
                  error: null,
                }),
            }),
          }),
        }
      }

      if (table === 'member_presence') {
        return {
          select: () => ({
            eq: () =>
              Promise.resolve({
                data: opts.members
                  .filter((m) => m.lastSeenAgoMs !== undefined)
                  .map((m) => ({
                    user_id: m.user_id,
                    status: m.status ?? 'online',
                    last_seen_at: new Date(
                      NOW - (m.lastSeenAgoMs ?? 0),
                    ).toISOString(),
                  })),
                error: null,
              }),
          }),
        }
      }

      // conversations
      return {
        select: () => ({
          eq: () => ({
            neq: () => ({
              not: () =>
                Promise.resolve({
                  data: (opts.openAssignments ?? []).map((id) => ({
                    assigned_agent_id: id,
                  })),
                  error: null,
                }),
            }),
          }),
        }),
      }
    },
  } as unknown as SupabaseClient

  return { db, captured }
}

describe('pickRoundRobinAgent: load balancing', () => {
  it('picks the member with the fewest open conversations', async () => {
    const { db } = makeDb({
      members: [
        { user_id: 'a', account_role: 'agent' },
        { user_id: 'b', account_role: 'agent' },
        { user_id: 'c', account_role: 'agent' },
      ],
      openAssignments: ['a', 'a', 'a', 'c', 'c'],
    })

    expect(await pickRoundRobinAgent(db, 'acct', {}, NOW)).toBe('b')
  })

  it('picks a member holding nothing over one holding work', async () => {
    const { db } = makeDb({
      members: [
        { user_id: 'busy', account_role: 'agent' },
        { user_id: 'idle', account_role: 'agent' },
      ],
      openAssignments: ['busy'],
    })

    expect(await pickRoundRobinAgent(db, 'acct', {}, NOW)).toBe('idle')
  })

  it('self-balances across successive assignments', async () => {
    // The property that makes a stored rotation cursor unnecessary: an
    // all-zero tie is broken once, and the winner is no longer tied.
    const members: Member[] = [
      { user_id: 'a', account_role: 'agent' },
      { user_id: 'b', account_role: 'agent' },
      { user_id: 'c', account_role: 'agent' },
    ]
    const assigned: string[] = []

    for (let i = 0; i < 3; i++) {
      const { db } = makeDb({ members, openAssignments: [...assigned] })
      assigned.push((await pickRoundRobinAgent(db, 'acct', {}, NOW))!)
    }

    expect([...assigned].sort()).toEqual(['a', 'b', 'c'])
  })

  it('ignores load held by members who are no longer eligible', async () => {
    // A departed teammate's 50 open conversations must not make everyone else
    // look busy — or worse, win the pick.
    const { db } = makeDb({
      members: [{ user_id: 'a', account_role: 'agent' }],
      openAssignments: Array.from({ length: 50 }, () => 'ghost'),
    })

    expect(await pickRoundRobinAgent(db, 'acct', {}, NOW)).toBe('a')
  })

  it('is deterministic when everyone is equally loaded', async () => {
    const { db } = makeDb({
      members: [
        { user_id: 'zoe', account_role: 'agent' },
        { user_id: 'adam', account_role: 'agent' },
      ],
    })

    expect(await pickRoundRobinAgent(db, 'acct', {}, NOW)).toBe('adam')
  })
})

describe('pickRoundRobinAgent: role eligibility', () => {
  it('defaults to everyone who can reply, excluding viewers', async () => {
    const { db, captured } = makeDb({
      members: [{ user_id: 'a', account_role: 'agent' }],
    })

    await pickRoundRobinAgent(db, 'acct', {}, NOW)

    expect(captured.roles).toEqual(DEFAULT_ASSIGNABLE_ROLES)
    expect(captured.roles).not.toContain('viewer')
  })

  it('honours an explicit role list', async () => {
    const { db } = makeDb({
      members: [
        { user_id: 'owner-1', account_role: 'owner' },
        { user_id: 'agent-1', account_role: 'agent' },
      ],
    })

    expect(
      await pickRoundRobinAgent(db, 'acct', { roles: ['agent'] }, NOW),
    ).toBe('agent-1')
  })

  it('treats an empty role list as "not configured" rather than "nobody"', async () => {
    // A config saved with every checkbox cleared must not silently disable
    // assignment — the UI can produce this, and the safe reading is the default.
    const { db } = makeDb({
      members: [{ user_id: 'a', account_role: 'agent' }],
    })

    expect(await pickRoundRobinAgent(db, 'acct', { roles: [] }, NOW)).toBe('a')
  })

  it('returns undefined when the account has no eligible member', async () => {
    const { db } = makeDb({
      members: [{ user_id: 'v', account_role: 'viewer' }],
    })

    expect(await pickRoundRobinAgent(db, 'acct', {}, NOW)).toBeUndefined()
  })
})

describe('pickRoundRobinAgent: presence', () => {
  it('ignores presence entirely unless online_only is set', async () => {
    const { db } = makeDb({
      members: [
        { user_id: 'a', account_role: 'agent', lastSeenAgoMs: 30 * 86_400_000 },
      ],
    })

    expect(await pickRoundRobinAgent(db, 'acct', {}, NOW)).toBe('a')
  })

  it('skips members whose heartbeat has gone stale', async () => {
    const { db } = makeDb({
      members: [
        { user_id: 'gone', account_role: 'agent', lastSeenAgoMs: OFFLINE_AFTER_MS + 1 },
        { user_id: 'here', account_role: 'agent', lastSeenAgoMs: 1_000 },
      ],
      // 'here' is busier, and still wins because 'gone' is unreachable.
      openAssignments: ['here', 'here'],
    })

    expect(await pickRoundRobinAgent(db, 'acct', { online_only: true }, NOW)).toBe(
      'here',
    )
  })

  it('counts an idle member as reachable', async () => {
    // 'away' means the tab is open and they are logged in — still assignable.
    const { db } = makeDb({
      members: [
        { user_id: 'idle', account_role: 'agent', status: 'away', lastSeenAgoMs: 1_000 },
      ],
    })

    expect(
      await pickRoundRobinAgent(db, 'acct', { online_only: true }, NOW),
    ).toBe('idle')
  })

  it('treats a member with no presence row at all as offline', async () => {
    const { db } = makeDb({
      members: [{ user_id: 'never-seen', account_role: 'agent' }],
    })

    expect(
      await pickRoundRobinAgent(db, 'acct', { online_only: true }, NOW),
    ).toBeUndefined()
  })

  it('assigns to nobody rather than to someone offline', async () => {
    // The deliberate outcome: an unassigned conversation stays visible to the
    // whole team in the shared inbox. Parking it on someone who logged off on
    // Friday is worse.
    const { db } = makeDb({
      members: [
        { user_id: 'a', account_role: 'agent', lastSeenAgoMs: OFFLINE_AFTER_MS + 1 },
        { user_id: 'b', account_role: 'agent', lastSeenAgoMs: OFFLINE_AFTER_MS + 1 },
      ],
    })

    expect(
      await pickRoundRobinAgent(db, 'acct', { online_only: true }, NOW),
    ).toBeUndefined()
  })
})

describe('pickRoundRobinAgent: account defaults', () => {
  it('falls back to the account default when the step says nothing', async () => {
    const { db, captured } = makeDb({
      members: [
        { user_id: 'owner-1', account_role: 'owner' },
        { user_id: 'agent-1', account_role: 'agent' },
      ],
      accountDefaults: {
        default_assignment_roles: ['agent'],
        default_assignment_online_only: null,
      },
    })

    expect(await pickRoundRobinAgent(db, 'acct', {}, NOW)).toBe('agent-1')
    expect(captured.roles).toEqual(['agent'])
  })

  it('lets an explicit step config beat the account default', async () => {
    // The point of keeping both: one automation can deliberately differ
    // (VIP enquiries to admins only) without changing the account setting.
    const { db, captured } = makeDb({
      members: [
        { user_id: 'owner-1', account_role: 'owner' },
        { user_id: 'agent-1', account_role: 'agent' },
      ],
      accountDefaults: {
        default_assignment_roles: ['agent'],
        default_assignment_online_only: null,
      },
    })

    await pickRoundRobinAgent(db, 'acct', { roles: ['owner'] }, NOW)
    expect(captured.roles).toEqual(['owner'])
  })

  it('applies the account online-only default', async () => {
    const { db } = makeDb({
      members: [
        {
          user_id: 'gone',
          account_role: 'agent',
          lastSeenAgoMs: OFFLINE_AFTER_MS + 1,
        },
      ],
      accountDefaults: {
        default_assignment_roles: null,
        default_assignment_online_only: true,
      },
    })

    expect(await pickRoundRobinAgent(db, 'acct', {}, NOW)).toBeUndefined()
  })

  it('lets the step opt out of the account online-only default', async () => {
    const { db } = makeDb({
      members: [
        {
          user_id: 'gone',
          account_role: 'agent',
          lastSeenAgoMs: OFFLINE_AFTER_MS + 1,
        },
      ],
      accountDefaults: {
        default_assignment_roles: null,
        default_assignment_online_only: true,
      },
    })

    expect(
      await pickRoundRobinAgent(db, 'acct', { online_only: false }, NOW),
    ).toBe('gone')
  })

  it('behaves exactly as before on an account that never configured defaults', async () => {
    // NULL columns must not change anything for existing installs.
    const { db, captured } = makeDb({
      members: [{ user_id: 'a', account_role: 'agent' }],
      accountDefaults: {
        default_assignment_roles: null,
        default_assignment_online_only: false,
      },
    })

    expect(await pickRoundRobinAgent(db, 'acct', {}, NOW)).toBe('a')
    expect(captured.roles).toEqual(DEFAULT_ASSIGNABLE_ROLES)
  })
})
