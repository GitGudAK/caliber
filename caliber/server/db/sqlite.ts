import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrations } from './migrations.ts'

export function openDatabase(file: string): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  migrate(db)
  return db
}

function migrate(db: DatabaseSync) {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
  const applied = new Set(
    (db.prepare('SELECT id FROM _migrations').all() as { id: number }[]).map((row) => row.id),
  )
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue
    db.exec('BEGIN')
    try {
      db.exec(migration.sql)
      db.prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      )
      db.exec('COMMIT')
      console.log(`[db] applied migration ${migration.id} ${migration.name}`)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
