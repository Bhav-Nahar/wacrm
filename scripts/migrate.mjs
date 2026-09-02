// Applies supabase/migrations/*.sql in order, once each.
// Run as Railway's pre-deploy command: node scripts/migrate.mjs
// Needs DATABASE_URL (Supabase -> Connect -> session pooler URI).
// ponytail: no down-migrations, no checksums -- add if migrations start getting edited after ship.
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

const dir = path.join(process.cwd(), 'supabase', 'migrations')
const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set')

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await client.connect()

try {
  await client.query(
    'create table if not exists applied_migrations (name text primary key, applied_at timestamptz default now())',
  )
  const { rows } = await client.query('select name from applied_migrations')
  const done = new Set(rows.map((r) => r.name))
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()

  for (const name of files) {
    if (done.has(name)) continue
    const sql = await readFile(path.join(dir, name), 'utf8')
    console.log(`applying ${name}`)
    await client.query('begin')
    try {
      await client.query(sql)
      await client.query('insert into applied_migrations (name) values ($1)', [name])
      await client.query('commit')
    } catch (err) {
      await client.query('rollback')
      throw new Error(`migration ${name} failed: ${err.message}`, { cause: err })
    }
  }
  console.log('migrations up to date')
} finally {
  await client.end()
}
