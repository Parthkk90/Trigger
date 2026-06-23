import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/flowlink';
const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export function verifyMigrationPreflight(options = {}) {
  const migrationsDir = options.migrationsDir || DEFAULT_MIGRATIONS_DIR;
  const databaseUrl = options.databaseUrl || DEFAULT_DATABASE_URL;

  if (!databaseUrl || typeof databaseUrl !== 'string') {
    throw new Error('DATABASE_URL is required');
  }

  // Validates basic URL shape before startup/migration work.
  new URL(databaseUrl);

  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`migrations directory not found: ${migrationsDir}`);
  }
}

export function listMigrationFiles(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

export function parseMigrationSql(content) {
  const marker = /^\s*--\s+down\s*$/im;
  const match = content.match(marker);

  if (!match) {
    return {
      upSql: content.trim(),
      downSql: null,
    };
  }

  const splitAt = match.index;
  return {
    upSql: content.slice(0, splitAt).trim(),
    downSql: content.slice(splitAt + match[0].length).trim(),
  };
}

export async function ensureSchemaMigrationsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getAppliedMigrations(pool) {
  const result = await pool.query(`SELECT name FROM schema_migrations`);
  return new Set(result.rows.map((row) => row.name));
}

export async function runMigrations(options = {}) {
  const databaseUrl = options.databaseUrl || DEFAULT_DATABASE_URL;
  const migrationsDir = options.migrationsDir || DEFAULT_MIGRATIONS_DIR;
  const ownsPool = !options.pool;
  const pool = options.pool || new Pool({ connectionString: databaseUrl });

  verifyMigrationPreflight({ databaseUrl, migrationsDir });

  try {
    await ensureSchemaMigrationsTable(pool);
    const applied = await getAppliedMigrations(pool);
    const files = listMigrationFiles(migrationsDir);
    const appliedNow = [];

    for (const file of files) {
      if (applied.has(file)) continue;

      const fullPath = path.join(migrationsDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      const parsed = parseMigrationSql(content);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (parsed.upSql) {
          await client.query(parsed.upSql);
        }
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      appliedNow.push(file);
    }

    return {
      applied: appliedNow,
      totalDiscovered: files.length,
    };
  } finally {
    if (ownsPool) {
      await pool.end();
    }
  }
}

export async function rollbackMigration(options = {}) {
  const databaseUrl = options.databaseUrl || DEFAULT_DATABASE_URL;
  const migrationsDir = options.migrationsDir || DEFAULT_MIGRATIONS_DIR;
  const ownsPool = !options.pool;
  const pool = options.pool || new Pool({ connectionString: databaseUrl });

  verifyMigrationPreflight({ databaseUrl, migrationsDir });

  try {
    await ensureSchemaMigrationsTable(pool);
    const result = await pool.query(
      `SELECT name FROM schema_migrations ORDER BY applied_at DESC, name DESC LIMIT 1`
    );

    if (result.rows.length === 0) {
      return { rolledBack: null, skipped: true };
    }

    const name = result.rows[0].name;
    const fullPath = path.join(migrationsDir, name);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`migration file missing for rollback: ${name}`);
    }

    const parsed = parseMigrationSql(fs.readFileSync(fullPath, 'utf8'));
    if (!parsed.downSql) {
      throw new Error(`down migration not defined for ${name}`);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(parsed.downSql);
      await client.query('DELETE FROM schema_migrations WHERE name = $1', [name]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return { rolledBack: name, skipped: false };
  } finally {
    if (ownsPool) {
      await pool.end();
    }
  }
}

