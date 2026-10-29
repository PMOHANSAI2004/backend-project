import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import pg from 'pg';

const { Pool } = pg;
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');
const sourcePath = path.resolve(process.env.SQLITE_DB_PATH || path.join(projectDir, 'data', 'healthsync.db'));
const databaseUrl = process.env.DATABASE_URL;
const allowedTables = [
  'users', 'doctors', 'appointments', 'messages', 'signals', 'reports',
  'prescriptions', 'reviews', 'vitals', 'notifications', 'favorites',
  'coupons', 'audit_log', 'ai_logs', 'settings'
];
const idTables = ['users', 'doctors', 'appointments', 'messages', 'signals', 'reports', 'prescriptions', 'reviews', 'vitals', 'notifications', 'audit_log', 'ai_logs'];
const tableCounts = {};
const maps = { users: new Map(), doctors: new Map(), appointments: new Map() };

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}
function mapRef(table, value) {
  if (value === null || value === undefined || value === '') return value;
  return maps[table]?.get(Number(value)) ?? value;
}
function sqliteRows(sqliteDb, table) {
  const found = sqliteDb.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name=${JSON.stringify(table)}`);
  if (!found.length || !found[0].values.length) return [];
  const result = sqliteDb.exec(`SELECT * FROM ${quoteIdent(table)}`);
  if (!result.length) return [];
  return result[0].values.map(values => Object.fromEntries(result[0].columns.map((col, i) => [col, values[i] ?? null])));
}
async function getTargetColumns(client, table) {
  const result = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table]
  );
  return new Set(result.rows.map(row => row.column_name));
}
function filteredRow(row, allowedColumns) {
  const out = {};
  for (const [key, value] of Object.entries(row)) if (allowedColumns.has(key)) out[key] = value;
  return out;
}
async function selectBy(client, table, column, value) {
  if (value === null || value === undefined) return null;
  const result = await client.query(`SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)}=$1 LIMIT 1`, [value]);
  return result.rows[0] || null;
}
async function insertRow(client, table, rawRow, targetColumns, { omitId = false, onConflict = '' } = {}) {
  const row = filteredRow(rawRow, targetColumns);
  if (omitId) delete row.id;
  const columns = Object.keys(row);
  if (!columns.length) throw new Error(`No shared columns available to import a row into ${table}.`);
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
  const values = columns.map(column => row[column]);
  const sql = `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES (${placeholders})${onConflict} RETURNING *`;
  const result = await client.query(sql, values);
  return result.rows[0] || null;
}
async function updateById(client, table, id, row, targetColumns, exclude = ['id']) {
  const filtered = filteredRow(row, targetColumns);
  for (const field of exclude) delete filtered[field];
  const columns = Object.keys(filtered);
  if (!columns.length) return;
  const sets = columns.map((column, i) => `${quoteIdent(column)}=$${i + 1}`).join(', ');
  await client.query(`UPDATE ${quoteIdent(table)} SET ${sets} WHERE id=$${columns.length + 1}`, [...columns.map(c => filtered[c]), id]);
}
async function insertPreservingId(client, table, row, targetColumns) {
  if (row.id !== undefined && row.id !== null) {
    const existing = await selectBy(client, table, 'id', row.id);
    if (!existing) {
      return await insertRow(client, table, row, targetColumns);
    }
  }
  return await insertRow(client, table, row, targetColumns, { omitId: true });
}
function mapUserFields(row) {
  return { ...row };
}
async function main() {
  if (!databaseUrl) throw new Error('DATABASE_URL is missing. For a local migration, use the PostgreSQL External Database URL in your temporary environment only; never commit it to GitHub.');
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`Source SQLite database not found: ${sourcePath}\nThe supplied original ZIP did not contain data/healthsync.db. Obtain the original database file before running migration. No PostgreSQL application data was changed.`);
  }

  const sourceBytes = fs.readFileSync(sourcePath);
  if (sourceBytes.length < 100) throw new Error('The SQLite source file is unexpectedly small; refusing to import it.');
  const sourceHash = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  const SQL = await initSqlJs({ locateFile: file => require.resolve(`sql.js/dist/${file}`) });
  const sqliteDb = new SQL.Database(sourceBytes);
  const sourceIntegrity = sqliteDb.exec('PRAGMA integrity_check');
  const integrityText = sourceIntegrity?.[0]?.values?.[0]?.[0];
  if (integrityText !== 'ok') throw new Error(`SQLite integrity_check failed (${integrityText ?? 'no result'}); refusing to import.`);

  const sourceTables = new Set(sqliteDb.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values.map(row => row[0]) || []);
  const availableTables = allowedTables.filter(table => sourceTables.has(table));
  if (!availableTables.length) throw new Error('No expected HealthSync data tables were found in the SQLite database; refusing to import.');
  const sourceTotal = availableTables.reduce((sum, table) => sum + sqliteRows(sqliteDb, table).length, 0);
  if (!sourceTotal) throw new Error('The source database has no rows in the known HealthSync tables. No import was performed.');

  const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 15000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS healthsync_migration_runs (
      source_sha256 TEXT PRIMARY KEY,
      source_file TEXT NOT NULL,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      row_counts JSONB NOT NULL DEFAULT '{}'::jsonb
    )`);
    const already = await client.query('SELECT imported_at FROM healthsync_migration_runs WHERE source_sha256=$1', [sourceHash]);
    if (already.rowCount) {
      await client.query('ROLLBACK');
      console.log(`This exact SQLite file was already migrated at ${already.rows[0].imported_at}. No records were changed.`);
      return;
    }

    const columns = {};
    for (const table of availableTables) {
      columns[table] = await getTargetColumns(client, table);
      if (!columns[table].size) throw new Error(`PostgreSQL table "${table}" does not exist. Deploy/initialize the PostgreSQL backend schema first.`);
    }

    // Users: match same e-mail as the same account and restore the source account fields;
    // if the numeric id conflicts with another account, insert with a new id and map references.
    tableCounts.users = { imported: 0, mergedByEmail: 0 };
    for (const source of sqliteRows(sqliteDb, 'users')) {
      const row = mapUserFields(source);
      const byEmail = await selectBy(client, 'users', 'email', row.email);
      let target;
      if (byEmail) {
        await updateById(client, 'users', byEmail.id, row, columns.users, ['id']);
        target = { ...byEmail, ...filteredRow(row, columns.users), id: byEmail.id };
        tableCounts.users.mergedByEmail++;
      } else {
        target = await insertPreservingId(client, 'users', row, columns.users);
        tableCounts.users.imported++;
      }
      maps.users.set(Number(source.id), Number(target.id));
    }

    // Doctors have a unique user_id; account mapping is applied before matching.
    tableCounts.doctors = { imported: 0, mergedByUser: 0 };
    for (const source of sqliteRows(sqliteDb, 'doctors')) {
      const row = { ...source, user_id: mapRef('users', source.user_id) };
      const byUser = await selectBy(client, 'doctors', 'user_id', row.user_id);
      let target;
      if (byUser) {
        await updateById(client, 'doctors', byUser.id, row, columns.doctors, ['id', 'user_id']);
        target = { ...byUser, ...filteredRow(row, columns.doctors), id: byUser.id };
        tableCounts.doctors.mergedByUser++;
      } else {
        target = await insertPreservingId(client, 'doctors', row, columns.doctors);
        tableCounts.doctors.imported++;
      }
      maps.doctors.set(Number(source.id), Number(target.id));
    }

    const remappers = {
      appointments: row => ({ ...row, user_id: mapRef('users', row.user_id), doctor_id: mapRef('doctors', row.doctor_id) }),
      messages: row => ({ ...row, appointment_id: mapRef('appointments', row.appointment_id), sender_id: mapRef('users', row.sender_id) }),
      signals: row => ({ ...row, appointment_id: mapRef('appointments', row.appointment_id), from_user: mapRef('users', row.from_user) }),
      reports: row => ({ ...row, user_id: mapRef('users', row.user_id) }),
      prescriptions: row => ({ ...row, appointment_id: mapRef('appointments', row.appointment_id), user_id: mapRef('users', row.user_id), doctor_id: mapRef('doctors', row.doctor_id) }),
      reviews: row => ({ ...row, appointment_id: mapRef('appointments', row.appointment_id), user_id: mapRef('users', row.user_id), doctor_id: mapRef('doctors', row.doctor_id) }),
      vitals: row => ({ ...row, user_id: mapRef('users', row.user_id) }),
      notifications: row => ({ ...row, user_id: mapRef('users', row.user_id) }),
      audit_log: row => ({ ...row, actor_id: mapRef('users', row.actor_id) }),
      ai_logs: row => ({ ...row, user_id: mapRef('users', row.user_id) })
    };

    // Appointments are imported as independent historical records. Conflicting IDs are reassigned,
    // and all dependent rows below use the ID map, keeping relationships intact.
    const standardOrder = ['appointments', 'messages', 'signals', 'reports', 'prescriptions', 'reviews', 'vitals', 'notifications', 'audit_log', 'ai_logs'];
    for (const table of standardOrder) {
      if (!sourceTables.has(table)) continue;
      tableCounts[table] = { imported: 0 };
      for (const source of sqliteRows(sqliteDb, table)) {
        const row = remappers[table](source);
        const target = await insertPreservingId(client, table, row, columns[table]);
        if (table === 'appointments') maps.appointments.set(Number(source.id), Number(target.id));
        tableCounts[table].imported++;
      }
    }

    if (sourceTables.has('favorites')) {
      tableCounts.favorites = { inserted: 0, alreadyPresent: 0 };
      for (const source of sqliteRows(sqliteDb, 'favorites')) {
        const row = { ...source, user_id: mapRef('users', source.user_id), doctor_id: mapRef('doctors', source.doctor_id) };
        const before = await client.query('SELECT 1 FROM favorites WHERE user_id=$1 AND doctor_id=$2', [row.user_id, row.doctor_id]);
        if (before.rowCount) { tableCounts.favorites.alreadyPresent++; continue; }
        await insertRow(client, 'favorites', row, columns.favorites, { onConflict: ' ON CONFLICT (user_id, doctor_id) DO NOTHING' });
        tableCounts.favorites.inserted++;
      }
    }
    if (sourceTables.has('coupons')) {
      tableCounts.coupons = { inserted: 0, mergedByCode: 0 };
      for (const source of sqliteRows(sqliteDb, 'coupons')) {
        const existing = await selectBy(client, 'coupons', 'code', source.code);
        if (existing) {
          const row = filteredRow(source, columns.coupons);
          const cols = Object.keys(row).filter(c => c !== 'code');
          if (cols.length) await client.query(`UPDATE coupons SET ${cols.map((c, i) => `${quoteIdent(c)}=$${i + 1}`).join(', ')} WHERE code=$${cols.length + 1}`, [...cols.map(c => row[c]), source.code]);
          tableCounts.coupons.mergedByCode++;
        } else {
          await insertRow(client, 'coupons', source, columns.coupons);
          tableCounts.coupons.inserted++;
        }
      }
    }
    if (sourceTables.has('settings')) {
      tableCounts.settings = { insertedOrUpdated: 0 };
      for (const source of sqliteRows(sqliteDb, 'settings')) {
        await client.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [source.key, source.value]);
        tableCounts.settings.insertedOrUpdated++;
      }
    }

    // Reset sequences above imported IDs so the next application inserts do not reuse them.
    for (const table of idTables) {
      if (!columns[table]) continue;
      await client.query(`SELECT setval(pg_get_serial_sequence('public.${table}', 'id'), COALESCE((SELECT MAX(id) FROM public.${table}), 1), EXISTS(SELECT 1 FROM public.${table}))`);
    }

    await client.query('INSERT INTO healthsync_migration_runs (source_sha256, source_file, row_counts) VALUES ($1,$2,$3::jsonb)', [sourceHash, path.basename(sourcePath), JSON.stringify(tableCounts)]);
    await client.query('COMMIT');
    console.log('Migration completed successfully. No target rows or tables were deleted.');
    console.log(`Source file SHA-256: ${sourceHash}`);
    console.log(JSON.stringify(tableCounts, null, 2));
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* keep original failure */ }
    console.error('Migration failed and was rolled back. No partial import was committed.');
    throw error;
  } finally {
    client.release();
    await pool.end();
    sqliteDb.close();
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
