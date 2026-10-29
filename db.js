import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { fileURLToPath } from 'url';

const { Pool, types } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const dataDir = path.join(__dirname, 'data');
export const uploadDir = path.join(__dirname, 'uploads');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Add the Internal Database URL from your Render PostgreSQL service to the backend environment.');
}
// Return PostgreSQL timestamps and numeric aggregates in predictable JS types.
types.setTypeParser(1114, value => value);
types.setTypeParser(1184, value => value);
types.setTypeParser(20, value => Number(value));
types.setTypeParser(1700, value => Number(value));
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
pool.on('error', err => console.error('Unexpected PostgreSQL pool error:', err.message));

const schemaSQL = `
CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, phone TEXT DEFAULT '', role TEXT NOT NULL DEFAULT 'patient', status TEXT NOT NULL DEFAULT 'active', gender TEXT DEFAULT '', dob TEXT DEFAULT '', blood_group TEXT DEFAULT '', city TEXT DEFAULT '', allergies TEXT DEFAULT '', conditions TEXT DEFAULT '', emergency_contact TEXT DEFAULT '', photo TEXT DEFAULT '', last_login TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS doctors (id SERIAL PRIMARY KEY, user_id INTEGER UNIQUE NOT NULL, specialty TEXT NOT NULL, qualifications TEXT DEFAULT '', experience INTEGER DEFAULT 1, rating REAL DEFAULT 0, reviews_count INTEGER DEFAULT 0, fee INTEGER DEFAULT 500, bio TEXT DEFAULT '', color TEXT DEFAULT '#cfe1dc', languages TEXT DEFAULT 'English', city TEXT DEFAULT '', clinic TEXT DEFAULT '', modes TEXT DEFAULT 'Video,Chat', schedule TEXT DEFAULT '{}', leave_dates TEXT DEFAULT '[]', slot_minutes INTEGER DEFAULT 30, status TEXT NOT NULL DEFAULT 'approved', reg_no TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS appointments (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, doctor_id INTEGER NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, mode TEXT NOT NULL, reason TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'confirmed', fee INTEGER DEFAULT 0, discount INTEGER DEFAULT 0, platform_fee INTEGER DEFAULT 0, coupon TEXT DEFAULT '', payment_status TEXT DEFAULT 'pending', payment_method TEXT DEFAULT '', diagnosis TEXT DEFAULT '', soap TEXT DEFAULT '', follow_up TEXT DEFAULT '', ai_triage TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, appointment_id INTEGER NOT NULL, sender_id INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS signals (id SERIAL PRIMARY KEY, appointment_id INTEGER NOT NULL, from_user INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS reports (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, file_name TEXT NOT NULL, original_name TEXT DEFAULT '', type TEXT, size TEXT, category TEXT DEFAULT 'Lab report', uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS prescriptions (id SERIAL PRIMARY KEY, appointment_id INTEGER, user_id INTEGER NOT NULL, doctor_id INTEGER NOT NULL, diagnosis TEXT DEFAULT '', medicines TEXT DEFAULT '[]', instructions TEXT DEFAULT '', follow_up TEXT DEFAULT '', signature TEXT DEFAULT '', issued_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS reviews (id SERIAL PRIMARY KEY, appointment_id INTEGER UNIQUE, user_id INTEGER NOT NULL, doctor_id INTEGER NOT NULL, rating INTEGER NOT NULL, comment TEXT DEFAULT '', status TEXT DEFAULT 'visible', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS vitals (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, value REAL NOT NULL, value2 REAL, recorded_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS notifications (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL, body TEXT DEFAULT '', type TEXT DEFAULT 'info', link TEXT DEFAULT '', read INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS favorites (user_id INTEGER NOT NULL, doctor_id INTEGER NOT NULL, PRIMARY KEY (user_id, doctor_id));
CREATE TABLE IF NOT EXISTS coupons (code TEXT PRIMARY KEY, percent INTEGER NOT NULL, description TEXT DEFAULT '', active INTEGER DEFAULT 1, uses INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit_log (id SERIAL PRIMARY KEY, actor_id INTEGER, actor_name TEXT, action TEXT NOT NULL, detail TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS ai_logs (id SERIAL PRIMARY KEY, user_id INTEGER, kind TEXT, urgency TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

// The old API used synchronous SQLite-shaped helpers. These Promise decorators
// preserve familiar query composition while requiring callers to await results.
function decorate(promise, kind) {
  return new Proxy(promise, {
    get(target, prop, receiver) {
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return target[prop].bind(target);
      if (kind === 'array' && prop === 'map') return fn => decorate(target.then(rows => Promise.all(rows.map((row, i) => fn(row, i, rows)))), 'array');
      if (kind === 'array' && prop === 'forEach') return fn => decorate(target.then(async rows => { for (let i = 0; i < rows.length; i++) await fn(rows[i], i, rows); }), 'result');
      if ((kind === 'row' || kind === 'result') && typeof prop === 'string') return target.then(value => value == null ? undefined : value[prop]);
      return Reflect.get(target, prop, receiver);
    }
  });
}

function convertPlaceholders(sql) {
  let out = '', inSingle = false, inDouble = false, param = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDouble) { out += ch; if (sql[i + 1] === "'" && inSingle) { out += sql[++i]; continue; } inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { out += ch; inDouble = !inDouble; continue; }
    if (ch === '?' && !inSingle && !inDouble) { out += `$${++param}`; continue; }
    out += ch;
  }
  return out;
}

const idTables = new Set(['users', 'doctors', 'appointments', 'messages', 'signals', 'reports', 'prescriptions', 'reviews', 'vitals', 'notifications', 'audit_log', 'ai_logs']);
export const all = (sql, params = []) => decorate(pool.query(convertPlaceholders(sql), params).then(result => result.rows), 'array');
export const get = (sql, params = []) => decorate(pool.query(convertPlaceholders(sql), params).then(result => result.rows[0]), 'row');
export const run = (sql, params = []) => {
  let query = String(sql).trim().replace(/;$/, '');
  const insert = query.match(/^INSERT\s+INTO\s+([a-z_][a-z0-9_]*)/i);
  const returnsId = insert && idTables.has(insert[1].toLowerCase()) && !/\bRETURNING\b/i.test(query);
  if (returnsId) query += ' RETURNING id';
  return decorate(pool.query(convertPlaceholders(query), params).then(result => ({
    lastInsertRowid: result.rows?.[0]?.id ?? null,
    changes: result.rowCount ?? 0
  })), 'result');
};

async function initSchema() {
  const client = await pool.connect();
  try {
    for (const statement of schemaSQL.split(';').map(s => s.trim()).filter(Boolean)) await client.query(statement);
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS photo TEXT DEFAULT ''");
    await client.query("ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS signature TEXT DEFAULT ''");
  } finally { client.release(); }
}
await initSchema();

export const ymd = (d = new Date()) => {
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
};
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

export const avatarDir = path.join(uploadDir, 'avatars');
fs.mkdirSync(avatarDir, { recursive: true });
// Demo signature (SVG) used only for seeded prescriptions
export const demoSignature = name => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="260" height="90" viewBox="0 0 260 90"><path d="M12 62 C40 10 60 80 84 40 S120 20 132 58 S170 70 188 34 S226 52 248 40" fill="none" stroke="#23343a" stroke-width="2.4" stroke-linecap="round"/><text x="18" y="84" font-family="cursive" font-size="13" fill="#23343a">${name.replace(/[<>&]/g,'')}</text></svg>`);

export const getSetting = async (k, d = '') => (await get('SELECT value FROM settings WHERE key=?', [k]))?.value ?? d;
export const setSetting = async (k, v) => await run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, String(v)]);

export const notify = async (userId, title, body = '', type = 'info', link = '') =>
  await run('INSERT INTO notifications (user_id,title,body,type,link) VALUES (?,?,?,?,?)', [userId, title, body, type, link]);
export const audit = async (actor, action, detail = '') =>
  await run('INSERT INTO audit_log (actor_id,actor_name,action,detail) VALUES (?,?,?,?)', [actor?.id || null, actor?.name || 'system', action, detail]);

export const CREDENTIALS = {
  admin: { email: 'admin@healthsync.health', password: 'Admin@123' },
  doctor: { email: 'mira.sen@healthsync.health', password: 'Doctor@123' },
  patient: { email: 'demo@healthsync.health', password: 'Patient@123' }
};

// ------------------------------------------------------------------ seed
async function seed() {
  let s = 20261013; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const hash = {
    admin: bcrypt.hashSync('Admin@123', 9), doctor: bcrypt.hashSync('Doctor@123', 9), patient: bcrypt.hashSync('Patient@123', 9)
  };
  const U = async (name, email, role, extra = {}) => await run(
    'INSERT INTO users (name,email,password,phone,role,gender,dob,blood_group,city,allergies,conditions,emergency_contact) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [name, email, hash[role], extra.phone || '', role, extra.gender || '', extra.dob || '', extra.blood || '', extra.city || '', extra.allergies || '', extra.conditions || '', extra.ec || '']
  ).lastInsertRowid;

  await U('HealthSync Admin', 'admin@healthsync.health', 'admin', { phone: '+91 90000 00001', city: 'Hyderabad' });

  const week = (days, blocks) => Object.fromEntries(days.map(d => [d, blocks]));
  const MF = ['mon', 'tue', 'wed', 'thu', 'fri'], MS = [...MF, 'sat'];
  const docs = [
    ['Dr. Mira Sen', 'mira.sen', 'General Medicine', 'MBBS, MD (Internal Medicine)', 12, 650, 'Warm, preventive care for everyday health and long-term wellbeing.', '#cfe1dc', 'English,Hindi,Bengali', 'Hyderabad', 'HealthSync Wellness Clinic', 'Video,Chat,Clinic', week(MS, [['09:00', '13:00'], ['15:00', '18:00']]), 30, 'approved'],
    ['Dr. Arjun Mehta', 'arjun.mehta', 'Cardiology', 'MBBS, DM (Cardiology)', 15, 900, 'Evidence-led heart care with an unhurried, human approach.', '#e8d4bf', 'English,Hindi,Gujarati', 'Hyderabad', 'HealthSync Heart Centre', 'Video,Chat,Clinic', week(MF, [['10:00', '14:00'], ['16:00', '19:00']]), 30, 'approved'],
    ['Dr. Leela Rao', 'leela.rao', 'Dermatology', 'MBBS, MD (Dermatology)', 9, 700, 'Thoughtful skin and hair consultations for every season of life.', '#e1d8ed', 'English,Telugu,Hindi', 'Vijayawada', 'HealthSync Skin Studio', 'Video,Chat', week(MS, [['09:30', '13:30'], ['15:30', '17:30']]), 20, 'approved'],
    ['Dr. Kabir Khan', 'kabir.khan', 'Mental Wellness', 'MD (Psychiatry), PGDip CBT', 11, 800, 'A calm, confidential space to make sense of what you feel.', '#f0dfbd', 'English,Hindi,Urdu', 'Bengaluru', 'HealthSync Mind Care', 'Video,Chat', week(['mon', 'tue', 'thu', 'fri', 'sat'], [['11:00', '15:00'], ['17:00', '20:00']]), 45, 'approved'],
    ['Dr. Sana Iyer', 'sana.iyer', 'Pediatrics', 'MBBS, DCH, MD (Pediatrics)', 10, 600, 'Gentle, parent-friendly care for newborns through teenagers.', '#d8e8e1', 'English,Tamil,Hindi', 'Chennai', 'HealthSync Little Ones', 'Video,Chat,Clinic', week(MS, [['09:00', '12:30'], ['16:00', '19:00']]), 20, 'approved'],
    ['Dr. Rohan Das', 'rohan.das', 'Orthopedics', 'MBBS, MS (Orthopaedics)', 14, 850, 'Joint, spine and sports injury care focused on getting you moving again.', '#f2e5c7', 'English,Hindi,Bengali', 'Kolkata', 'HealthSync Bone & Joint', 'Video,Clinic', week(MF, [['10:00', '13:00'], ['15:00', '18:00']]), 30, 'approved'],
    ['Dr. Nisha Verma', 'nisha.verma', 'Gynecology', 'MBBS, MS (Obstetrics & Gynaecology)', 13, 800, "Respectful, unrushed women's health care at every stage.", '#f0dcda', 'English,Hindi,Marathi', 'Pune', "HealthSync Women's Health", 'Video,Chat,Clinic', week(MS, [['09:00', '13:00'], ['15:00', '17:00']]), 30, 'approved'],
    ['Dr. Imran Qureshi', 'imran.qureshi', 'ENT', 'MBBS, MS (ENT)', 8, 600, 'Ear, nose and throat care with clear explanations and practical plans.', '#e5e1f0', 'English,Hindi,Urdu', 'Hyderabad', 'HealthSync ENT Clinic', 'Video,Chat,Clinic', week(MF, [['09:00', '12:00'], ['14:00', '17:00']]), 20, 'approved'],
    ['Dr. Tara Nair', 'tara.nair', 'Endocrinology', 'MBBS, DM (Endocrinology)', 7, 750, 'Diabetes, thyroid and hormone care. (Application awaiting review.)', '#cfe1dc', 'English,Malayalam', 'Kochi', 'HealthSync Metabolic Care', 'Video,Chat', week(MF, [['10:00', '13:00']]), 30, 'pending']
  ];
  const doctorIds = [];
  for (const [i, d] of docs.entries()) {
    const uid = await U(d[0], `${d[1]}@healthsync.health`, 'doctor', { phone: `+91 98000 0${1000 + i}`, city: d[9], gender: i % 2 ? 'Male' : 'Female' });
    const r = await run('INSERT INTO doctors (user_id,specialty,qualifications,experience,fee,bio,color,languages,city,clinic,modes,schedule,slot_minutes,status,reg_no) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [uid, d[2], d[3], d[4], d[5], d[6], d[7], d[8], d[9], d[10], d[11], JSON.stringify(d[12]), d[13], d[14], `MCI-${48000 + i * 137}`]);
    doctorIds.push({ id: r.lastInsertRowid, uid, fee: d[5], status: d[14], schedule: d[12], step: d[13], name: d[0] });
  }

  const pats = [
    ['Ananya Sharma', 'demo@healthsync.health', 'Female', '1992-04-18', 'B+', 'Hyderabad', 'Penicillin', 'Mild hypertension', '+91 98765 43210'],
    ['Rahul Verma', 'rahul.verma@example.com', 'Male', '1986-09-02', 'O+', 'Mumbai', '', 'Type 2 diabetes', ''],
    ['Priya Nair', 'priya.nair@example.com', 'Female', '1995-12-11', 'A+', 'Kochi', 'Dust', '', ''],
    ['Vikram Singh', 'vikram.singh@example.com', 'Male', '1979-01-25', 'AB+', 'Delhi', '', 'High cholesterol', ''],
    ['Meera Joshi', 'meera.joshi@example.com', 'Female', '2001-07-30', 'O-', 'Pune', 'Sulfa drugs', '', ''],
    ['Aditya Kulkarni', 'aditya.k@example.com', 'Male', '1990-03-09', 'B-', 'Pune', '', 'Asthma', '']
  ];
  const patientIds = await Promise.all(pats.map((p, i) => U(p[0], p[1], 'patient', { gender: p[2], dob: p[3], blood: p[4], city: p[5], allergies: p[6], conditions: p[7], ec: p[8], phone: `+91 97000 0${2000 + i}` })));
  const demo = patientIds[0];

  for (const c of [['WELCOME10', 10, 'Welcome offer for first consultation'], ['HEALTH20', 20, 'Healthy-living campaign'], ['SYNC5', 5, 'Loyalty reward']]) await run('INSERT INTO coupons (code,percent,description) VALUES (?,?,?)', c);
  await setSetting('platform_fee', 29); await setSetting('clinic_name', 'HealthSync'); await setSetting('support_email', 'care@healthsync.health');
  await setSetting('cancellation_hours', 4); await setSetting('allow_registration', 1); await setSetting('maintenance_banner', '');

  const reasons = ['Persistent headache for a week', 'Routine health check-up', 'Follow-up on blood pressure', 'Skin rash and itching', 'Anxiety and trouble sleeping', 'Knee pain while climbing stairs', 'Seasonal cold and cough', 'Fever for two days', 'Report review'];
  const approved = doctorIds.filter(d => d.status === 'approved');
  const today = new Date();
  const mk = async (patient, d, date, time, status, mode, reason) => {
    const paid = status === 'completed' || rnd() > 0.35;
    const platform = 29;
    const r = await run('INSERT INTO appointments (user_id,doctor_id,date,time,mode,reason,status,fee,platform_fee,payment_status,payment_method) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [patient, d.id, date, time, mode, reason, status, d.fee, platform, status === 'cancelled' ? 'refunded' : paid ? 'paid' : 'pending', paid ? 'online' : 'later']);
    return r.lastInsertRowid;
  };
  const used = new Set(); const reviewTexts = ['Listened patiently and explained everything clearly.', 'Very professional and kind. The video call was smooth.', 'Helpful advice and a clear plan. Highly recommend.', 'Quick, thorough, and reassuring.', 'Great experience, felt heard.'];
  // History: 70 days back
  for (let back = 70; back >= 1; back--) {
    const day = addDays(today, -back); const wd = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day.getDay()];
    const n = Math.floor(rnd() * 3) + (back < 30 ? 2 : 1);
    for (let k = 0; k < n; k++) {
      const d = pick(approved); if (!d.schedule[wd]) continue;
      const time = `${String(9 + Math.floor(rnd() * 8)).padStart(2, '0')}:${rnd() > .5 ? '00' : '30'}`;
      const key = `${d.id}|${ymd(day)}|${time}`; if (used.has(key)) continue; used.add(key);
      const p = pick(patientIds); const status = rnd() > .86 ? 'cancelled' : rnd() > .93 ? 'no-show' : 'completed';
      const id = await mk(p, d, ymd(day), time, status, pick(['Video', 'Video', 'Chat', 'Clinic']), pick(reasons));
      if (status === 'completed') {
        await run('UPDATE appointments SET diagnosis=?,soap=? WHERE id=?', [pick(['Viral upper respiratory infection', 'Essential hypertension — stable', 'Tension-type headache', 'Contact dermatitis', 'Generalised anxiety — mild', 'Mechanical knee pain', 'Seasonal allergic rhinitis']), JSON.stringify({ s: 'Patient reports symptoms as described in the booking reason.', o: 'Vitals stable. No acute distress.', a: 'Clinical impression recorded.', p: 'Medication, hydration, rest. Review if symptoms persist.' }), id]);
        if (rnd() > .45) await run('INSERT INTO reviews (appointment_id,user_id,doctor_id,rating,comment,created_at) VALUES (?,?,?,?,?,?)', [id, p, d.id, rnd() > .2 ? 5 : 4, pick(reviewTexts), ymd(day)]);
        if (rnd() > .5) await run('INSERT INTO prescriptions (appointment_id,user_id,doctor_id,diagnosis,medicines,instructions,issued_at,signature) VALUES (?,?,?,?,?,?,?,?)',
          [id, p, d.id, 'As per consultation', JSON.stringify([{ name: 'Paracetamol 500 mg', dose: '1 tablet', frequency: 'Twice daily after food', days: 3 }, { name: 'Cetirizine 10 mg', dose: '1 tablet', frequency: 'At bedtime', days: 5 }]), 'Drink plenty of fluids and rest. Review if symptoms persist beyond 5 days.', ymd(day), demoSignature(d.name)]);
      }
    }
  }
  // Demo patient: guaranteed history + upcoming
  const d0 = doctorIds[0], d1 = doctorIds[1];
  const past = ymd(addDays(today, -12)); const pid = await mk(demo, d1, past, '10:30', 'completed', 'Video', 'Follow-up on blood pressure');
  await run('UPDATE appointments SET diagnosis=?,soap=?,follow_up=? WHERE id=?', ['Essential hypertension — well controlled', JSON.stringify({ s: 'Occasional morning headaches. No chest pain or breathlessness.', o: 'BP 128/82 mmHg, pulse 74 bpm.', a: 'Hypertension, well controlled on current regimen.', p: 'Continue amlodipine. Low-salt diet. Home BP log. Review in 4 weeks.' }), ymd(addDays(today, 16)), pid]);
  await run('INSERT INTO prescriptions (appointment_id,user_id,doctor_id,diagnosis,medicines,instructions,follow_up,issued_at,signature) VALUES (?,?,?,?,?,?,?,?,?)',
    [pid, demo, d1.id, 'Essential hypertension', JSON.stringify([{ name: 'Amlodipine 5 mg', dose: '1 tablet', frequency: 'Once daily, morning', days: 30 }, { name: 'Vitamin D3 60,000 IU', dose: '1 capsule', frequency: 'Once weekly', days: 56 }]), 'Reduce salt, walk 30 minutes daily, and log your blood pressure each morning.', ymd(addDays(today, 16)), past, demoSignature(d1.name)]);
  await run('INSERT INTO reviews (appointment_id,user_id,doctor_id,rating,comment,created_at) VALUES (?,?,?,?,?,?)', [pid, demo, d1.id, 5, 'Dr. Mehta explained everything calmly and gave a clear plan.', past]);
  const up1 = await mk(demo, d0, ymd(addDays(today, 1)), '10:00', 'confirmed', 'Video', 'General check-up and fatigue');
  await mk(demo, doctorIds[2], ymd(addDays(today, 5)), '11:00', 'confirmed', 'Chat', 'Skin dryness and itching');
  await mk(patientIds[1], d0, ymd(today), '16:00', 'confirmed', 'Video', 'Blood sugar review');
  await mk(patientIds[2], d0, ymd(today), '16:30', 'confirmed', 'Chat', 'Fever for two days');
  await mk(patientIds[3], d0, ymd(today), '17:00', 'confirmed', 'Clinic', 'Routine health check-up');
  await mk(patientIds[4], d0, ymd(addDays(today, 1)), '11:30', 'confirmed', 'Video', 'Persistent headache for a week');
  await mk(patientIds[5], d0, ymd(addDays(today, 2)), '09:30', 'confirmed', 'Video', 'Seasonal cold and cough');
  await mk(patientIds[1], d1, ymd(addDays(today, 2)), '10:30', 'confirmed', 'Video', 'Chest discomfort on exertion');
  await mk(patientIds[3], doctorIds[3], ymd(addDays(today, 3)), '11:45', 'confirmed', 'Video', 'Anxiety and trouble sleeping');
  await mk(patientIds[2], doctorIds[5], ymd(addDays(today, 4)), '10:30', 'confirmed', 'Clinic', 'Knee pain while climbing stairs');
  // today: a completed one for Dr. Mira so "today" has a mix
  const done = await mk(patientIds[5], d0, ymd(today), '09:00', 'completed', 'Video', 'Report review');
  await run('UPDATE appointments SET diagnosis=? WHERE id=?', ['Normal reports — reassurance', done]);

  // Demo patient vitals (30 days)
  for (let i = 29; i >= 0; i -= 2) {
    const t = ymd(addDays(today, -i)) + ' 08:00:00';
    await run('INSERT INTO vitals (user_id,kind,value,value2,recorded_at) VALUES (?,?,?,?,?)', [demo, 'bp', 124 + Math.round(rnd() * 14), 80 + Math.round(rnd() * 8), t]);
    await run('INSERT INTO vitals (user_id,kind,value,recorded_at) VALUES (?,?,?,?)', [demo, 'weight', +(63.5 - i * 0.03 + rnd() * .6).toFixed(1), t]);
    await run('INSERT INTO vitals (user_id,kind,value,recorded_at) VALUES (?,?,?,?)', [demo, 'heart_rate', 68 + Math.round(rnd() * 10), t]);
    if (i % 4 === 1) await run('INSERT INTO vitals (user_id,kind,value,recorded_at) VALUES (?,?,?,?)', [demo, 'glucose', 92 + Math.round(rnd() * 18), t]);
  }
  await run('INSERT INTO reports (user_id,name,file_name,original_name,type,size,category) VALUES (?,?,?,?,?,?,?)', [demo, 'Complete blood count (sample)', 'sample-cbc.txt', 'cbc.txt', 'text/plain', '1 KB', 'Lab report']);
  fs.writeFileSync(path.join(uploadDir, 'sample-cbc.txt'), 'HEALTHSYNC — SAMPLE REPORT\nComplete blood count\nHaemoglobin: 13.4 g/dL\nWBC: 6,800 /uL\nPlatelets: 245,000 /uL\n');

  await notify(demo, 'Appointment confirmed', 'Your video consultation with Dr. Mira Sen is confirmed for tomorrow at 10:00.', 'appointment', '/patient/appointments');
  await notify(demo, 'Welcome to HealthSync', 'Try the Vita assistant for symptom guidance and quick booking.', 'info', '/patient/assistant');
  await notify(d0.uid, 'New booking', 'Ananya Sharma booked a video consultation for tomorrow at 10:00.', 'appointment', '/doctor/schedule');
  await notify(d0.uid, 'New review', 'A patient left you a 5-star review.', 'review', '/doctor/reviews');
  const admin = (await get("SELECT id FROM users WHERE role='admin'")).id;
  await notify(admin, 'Doctor application pending', 'Dr. Tara Nair (Endocrinology) is waiting for approval.', 'admin', '/admin/doctors');

  // rating cache
  for (const d of doctorIds) await recalcRating(d.id);
  await audit({ name: 'system' }, 'seed', 'Demo data created');
  void up1;
}

export async function recalcRating(doctorId) {
  const r = await get("SELECT COUNT(*) c, AVG(rating) a FROM reviews WHERE doctor_id=? AND status='visible'", [doctorId]);
  await run('UPDATE doctors SET rating=?, reviews_count=? WHERE id=?', [r.c ? +r.a.toFixed(1) : 0, r.c, doctorId]);
}

if (!(await get('SELECT id FROM users LIMIT 1')) && process.env.SEED_DEMO_DATA !== 'false') await seed();

process.once('SIGTERM', () => { pool.end().catch(err => console.error('PostgreSQL pool shutdown:', err.message)); });
process.once('SIGINT', () => { pool.end().catch(err => console.error('PostgreSQL pool shutdown:', err.message)); });
