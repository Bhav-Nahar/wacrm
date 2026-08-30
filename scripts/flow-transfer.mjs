#!/usr/bin/env node
/**
 * Move one flow (and the automations it triggers) between Supabase projects.
 *
 * Built instead of an export/import feature because the need is "get this
 * flow into production once", not "let users trade flows". The import half
 * already exists in-app via `POST /api/flows { template_slug }`; if a flow
 * turns out to be worth shipping to everyone, promote it into
 * src/lib/flows/templates.ts rather than growing this.
 *
 * The whole difficulty is that a flow is not self-contained. `set_tag` nodes
 * hold tag UUIDs and automations hold pipeline-stage UUIDs, none of which
 * exist in the target database. Export therefore rewrites every id to the
 * NAME behind it, and import resolves names back to target ids — creating
 * tags that are missing, and refusing rather than guessing when a pipeline
 * stage is (migrations own stages; inventing one would put deals somewhere
 * nobody configured).
 *
 *   export:  node scripts/flow-transfer.mjs export <flow-id> > flow.json
 *   import:  node scripts/flow-transfer.mjs import flow.json <account-id> <user-id>
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the environment, so
 * point it at whichever project is the source or target:
 *   set -a && . ./.env.local && set +a
 *   SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL node scripts/flow-transfer.mjs export <id> > flow.json
 */

const URL_ = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL_ || !KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}

async function rest(method, path, body) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

/** Every place a flow or automation hides a foreign UUID. */
const TAG_FIELDS = ['tag_id']
const STAGE_FIELDS = ['stage_id']

async function nameFor(table, id) {
  if (!id) return null
  const [row] = await rest('GET', `${table}?id=eq.${id}&select=name`)
  return row?.name ?? null
}

async function doExport(flowId) {
  const [flow] = await rest('GET', `flows?id=eq.${flowId}&select=*`)
  if (!flow) throw new Error(`No flow ${flowId}`)
  const nodes = await rest(
    'GET',
    `flow_nodes?flow_id=eq.${flowId}&select=node_key,node_type,config,position_x,position_y`,
  )

  // Collect the tags this flow sets, so we can also carry the automations
  // that listen for them — a flow whose tags trigger nothing is half a flow.
  const tagIds = new Set()
  for (const n of nodes) {
    for (const f of TAG_FIELDS) {
      if (n.config?.[f]) {
        tagIds.add(n.config[f])
        n.config[`${f}_name`] = await nameFor('tags', n.config[f])
        delete n.config[f]
      }
    }
  }

  const automations = []
  for (const a of await rest('GET', `automations?account_id=eq.${flow.account_id}&select=*`)) {
    const tid = a.trigger_config?.tag_id
    if (!tid || !tagIds.has(tid)) continue
    a.trigger_config = { tag_name: await nameFor('tags', tid) }
    a.steps = await rest(
      'GET',
      `automation_steps?automation_id=eq.${a.id}&select=step_type,step_config,position,branch`,
    )
    for (const s of a.steps) {
      for (const f of STAGE_FIELDS) {
        if (s.step_config?.[f]) {
          s.step_config[`${f}_name`] = await nameFor('pipeline_stages', s.step_config[f])
          delete s.step_config[f]
        }
      }
      delete s.step_config.pipeline_id // resolved from the stage on import
    }
    for (const k of ['id', 'account_id', 'user_id', 'created_at', 'updated_at',
                     'execution_count', 'last_executed_at']) delete a[k]
    automations.push(a)
  }

  for (const k of ['id', 'account_id', 'user_id', 'created_at', 'updated_at',
                   'execution_count', 'last_executed_at']) delete flow[k]
  process.stdout.write(JSON.stringify({ version: 1, flow, nodes, automations }, null, 2))
}

async function resolveTag(accountId, userId, name) {
  const [found] = await rest(
    'GET',
    `tags?account_id=eq.${accountId}&name=eq.${encodeURIComponent(name)}&select=id`,
  )
  if (found) return found.id
  const [made] = await rest('POST', 'tags', {
    account_id: accountId, user_id: userId, name, color: '#6b7280',
  })
  console.error(`  created tag "${name}"`)
  return made.id
}

async function resolveStage(accountId, name) {
  const rows = await rest(
    'GET',
    `pipeline_stages?name=eq.${encodeURIComponent(name)}&select=id,pipeline_id,pipelines!inner(account_id)&pipelines.account_id=eq.${accountId}`,
  )
  if (!rows.length) {
    // Deliberately fatal. Stages are pipeline structure the operator owns;
    // inventing one would file deals into a stage nobody configured.
    throw new Error(`No pipeline stage named "${name}" in the target account. Create it first.`)
  }
  return rows[0]
}

async function doImport(file, accountId, userId) {
  const { flow, nodes, automations } = JSON.parse(
    await (await import('node:fs/promises')).readFile(file, 'utf8'),
  )

  const [created] = await rest('POST', 'flows', {
    ...flow, account_id: accountId, user_id: userId,
    status: 'draft', // never import straight into a live flow
  })
  console.error(`flow ${created.id} (draft)`)

  for (const n of nodes) {
    for (const f of TAG_FIELDS) {
      const nm = n.config?.[`${f}_name`]
      if (nm) {
        n.config[f] = await resolveTag(accountId, userId, nm)
        delete n.config[`${f}_name`]
      }
    }
  }
  await rest('POST', 'flow_nodes', nodes.map((n) => ({ ...n, flow_id: created.id })))
  console.error(`  ${nodes.length} nodes`)

  for (const a of automations) {
    const { steps, trigger_config, ...rest_ } = a
    const [auto] = await rest('POST', 'automations', {
      ...rest_, account_id: accountId, user_id: userId,
      trigger_config: { tag_id: await resolveTag(accountId, userId, trigger_config.tag_name) },
    })
    for (const s of steps) {
      for (const f of STAGE_FIELDS) {
        const nm = s.step_config?.[`${f}_name`]
        if (nm) {
          const stage = await resolveStage(accountId, nm)
          s.step_config[f] = stage.id
          s.step_config.pipeline_id = stage.pipeline_id
          delete s.step_config[`${f}_name`]
        }
      }
    }
    await rest('POST', 'automation_steps',
      steps.map((s) => ({ ...s, automation_id: auto.id, parent_step_id: null })))
    console.error(`automation "${auto.name}" (${steps.length} steps)`)
  }
  console.error('\nImported as a DRAFT. Review it in the builder, then activate.')
}

const [cmd, ...rest_] = process.argv.slice(2)
try {
  if (cmd === 'export') await doExport(rest_[0])
  else if (cmd === 'import') await doImport(rest_[0], rest_[1], rest_[2])
  else {
    console.error('usage: flow-transfer.mjs export <flow-id> | import <file> <account-id> <user-id>')
    process.exit(1)
  }
} catch (e) {
  console.error('FAILED:', e.message)
  process.exit(1)
}
