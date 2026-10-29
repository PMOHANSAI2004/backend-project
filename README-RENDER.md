# HealthSync API — Render + PostgreSQL

This backend now uses a managed PostgreSQL database through `DATABASE_URL`; it no longer uses `sql.js` or a local SQLite database for application records.

## Before deploying

1. In Render, open the PostgreSQL service named `healthsync`.
2. Click **Connect** and copy its **Internal Database URL** (keep it private).
3. Open the web service `backend-project` → **Environment** and set:
   - `DATABASE_URL` = the Internal Database URL from `healthsync`
   - `JWT_SECRET` = a long random secret
   - `FRONTEND_URL` = your Netlify site origin, e.g. `https://your-site.netlify.app`
   - `EMERGENCY_NUMBER` = `112`
4. Keep both services in the same Render region (currently Oregon) to use the internal URL.
5. Set the Render web service build command to `npm install --no-audit --no-fund` and the start command to `npm start`. Use `npm install` rather than `npm ci`: the original lockfile referenced SQLite and is intentionally omitted from this archive. Render will resolve the dependencies in `package.json`, including the PostgreSQL `pg` driver. The health-check route is `/api/health`.

The backend requires the `DATABASE_URL` value to be the PostgreSQL service’s Internal Database URL. The backend creates its PostgreSQL tables at startup. If the database is empty, it seeds the existing demo data by default for compatibility with the original project. The demo logins are listed below; **do not use the demo accounts or seeded records for real patient care**. For a production database, set `SEED_DEMO_DATA=false` before the first deploy and implement a secure admin bootstrap process first.

## Verify

Open `https://<your-render-service>.onrender.com/api/health`. It should return a JSON response similar to:

```json
{"ok":true,"service":"HealthSync API","ai":"built-in"}
```

Then verify the following with test accounts: registration, login, doctor listings, appointments, messages, prescriptions, vitals, and admin dashboard queries. In the PostgreSQL service, use the database's Query/Connect tooling to verify that tables such as `users`, `appointments`, `prescriptions`, and `vitals` have been created.

## Important data-storage note

Patient/account/application records are stored in PostgreSQL. Uploaded documents and profile images are still saved under the backend `uploads/` directory; that directory is **not persistent on Render Free**. Do not rely on file uploads across restarts/redeploys until you configure persistent file storage (e.g. object storage) and update the upload code. Database persistence does not make uploaded files persistent.

## Demo credentials (only when demo seed is enabled)

- Admin: `admin@healthsync.health` / `Admin@123`
- Doctor: `mira.sen@healthsync.health` / `Doctor@123`
- Patient: `demo@healthsync.health` / `Patient@123`

Change/remove these credentials before any real deployment. This application is a project starting point and should undergo security, privacy, data-protection and clinical safety review before storing real medical records.

## Netlify proxy

Ensure your frontend `netlify.toml` forwards API requests to the actual Render web-service URL:

```toml
[[redirects]]
  from = "/api/*"
  to = "https://<your-render-service>.onrender.com/api/:splat"
  status = 200
  force = true

[[redirects]]
  from = "/uploads/*"
  to = "https://<your-render-service>.onrender.com/uploads/:splat"
  status = 200
  force = true

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

## Preserve and merge data from the old SQLite database (non-destructive)

**Do not delete the old database or redeploy over the only copy before making a backup.** The original `HealthSync-Render-Backend.zip` provided for this update contains source code only; it does not include the live `data/healthsync.db` file. The migration tool requires the real SQLite database file from the previous deployment or from your local backup.

This archive includes `scripts/migrate-sqlite-to-postgres.js`. It is designed to merge the SQLite rows into the already-initialized PostgreSQL database without dropping tables or deleting rows. It wraps the import in a transaction, preserves existing PostgreSQL rows, maps conflicting numeric IDs to new IDs while remapping dependent references, and records the SHA-256 of the imported SQLite file in `healthsync_migration_runs` to prevent accidentally importing the exact same file twice. If the import fails, the transaction is rolled back.

### Before running the migration

1. Locate the original `data/healthsync.db` file. Set `SQLITE_DB_PATH` to its full path. If you do not have this file, stop here; the historic records cannot be reconstructed from the source ZIP alone.
2. Make a separate backup of the SQLite file and of the target PostgreSQL database before making changes.
3. Use the PostgreSQL **External Database URL** for a migration process running on your Windows computer. Render-hosted services should continue to use the Internal Database URL. Keep the connection URL secret. External connections require TLS; use the URL Render provides with its SSL requirement.
4. Make sure the PostgreSQL tables have been initialized by the updated backend, and keep the app's `DATABASE_URL` set to the same target database.
5. In PowerShell, from this backend folder, run (substitute the real paths/URL; don't paste secrets into GitHub):

```powershell
$env:SQLITE_DB_PATH = "C:\path\to\old\data\healthsync.db"
$env:DATABASE_URL = "<Render PostgreSQL External Database URL>"
npm install --no-audit --no-fund
npm run migrate:sqlite
```

For local migration, only put the external URL in the current PowerShell session; do not commit it to the repository. When the command completes, review the row-count summary. If it fails, it rolls back and reports the error. It never issues `DROP TABLE` or `DELETE FROM`.

### What is and is not migrated

- Rows in the HealthSync SQLite tables are merged into the PostgreSQL tables.
- Existing PostgreSQL rows are not deleted. Accounts with matching email addresses and doctor records matching the same user are merged so their original account/profile values can be restored; imported historical appointments and related records are added, with ID references remapped where needed.
- `uploads/` files (including actual report documents and profile images) are not stored inside SQLite. Preserve and back up the old `uploads/` directory separately; the database migration does not upload those binary files to persistent object storage.
- The script can only migrate the SQLite database you supply. It cannot retrieve files from Render's filesystem remotely, and the source ZIP does not contain the live database.

Run this once for the original source database file. Do not run it against a different changed copy of the same source data without reviewing the migration implications, because new source-file hashes are treated as new migration snapshots.
