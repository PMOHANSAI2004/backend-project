import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { all, get, run, ymd, addDays, uploadDir, avatarDir, getSetting, setSetting, notify, audit, recalcRating, CREDENTIALS } from './db.js';
import * as AI from './ai.js';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'healthsync-local-secret-change-me';
const FRONTEND_URL = process.env.FRONTEND_URL || '';
const allowedOrigins = new Set([FRONTEND_URL].filter(Boolean));

const app = express();
// Express 4 does not automatically catch rejected async route handlers.
for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const register = app[method].bind(app);
  app[method] = (route, ...handlers) => register(route, ...handlers.map(handler => {
    if (typeof handler !== 'function') return handler;
    return function asyncRouteGuard(req, res, next) {
      try {
        const result = handler(req, res, next);
        if (result && typeof result.catch === 'function') result.catch(err => {
          console.error('Route error:', err);
          if (!res.headersSent) res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
          else next(err);
        });
        return result;
      } catch (err) {
        console.error('Route error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
        else next(err);
      }
    };
  }));
}
app.use(cors({
  origin: (origin, callback) => {
    const isLocal = !origin || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
    callback(null, isLocal || allowedOrigins.has(origin));
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
const upload = multer({ dest: uploadDir, limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: (_, f, cb) => cb(null, /pdf|image|text|word|officedocument/.test(f.mimetype)) });

/* ------------------------------------------------------------ helpers */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => { console.error(e); res.status(500).json({ error: 'Something went wrong on our side. Please try again.' }); });
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const sanitize = (s, n = 500) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, n);
const publicUser = u => u && ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, status: u.status, gender: u.gender, dob: u.dob, blood_group: u.blood_group, city: u.city, allergies: u.allergies, conditions: u.conditions, emergency_contact: u.emergency_contact, photo: u.photo, created_at: u.created_at, last_login: u.last_login });
const tokenFor = u => jwt.sign({ id: u.id, role: u.role }, JWT_SECRET, { expiresIn: '7d' });
const DOC_SQL = 'SELECT d.*, u.name, u.email, u.phone, u.gender, u.photo FROM doctors d JOIN users u ON u.id=d.user_id';
const docOut = d => d && ({ ...d, languages: String(d.languages || '').split(',').filter(Boolean), modes: String(d.modes || '').split(',').filter(Boolean), schedule: J(d.schedule, {}), leave_dates: J(d.leave_dates, []) });
const APPT_SQL = `SELECT a.*, d.specialty, d.color, d.user_id doctor_user_id, d.clinic, du.name doctor_name, du.photo doctor_photo, du.gender doctor_gender, pu.photo patient_photo, pu.gender patient_gender, pu.name patient_name, pu.email patient_email, pu.phone patient_phone FROM appointments a JOIN doctors d ON d.id=a.doctor_id JOIN users du ON du.id=d.user_id JOIN users pu ON pu.id=a.user_id`;
const apptOut = a => a && ({ ...a, soap: J(a.soap, null), total: a.fee + a.platform_fee - a.discount });

const attempts = new Map();
const limited = key => { const now = Date.now(); const arr = (attempts.get(key) || []).filter(t => now - t < 15 * 60 * 1000); attempts.set(key, arr); return arr.length >= 10; };

const auth = async (req, res, next) => {
  try {
    const t = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
    const p = jwt.verify(t, JWT_SECRET);
    const u = await get('SELECT * FROM users WHERE id=?', [p.id]);
    if (!u) throw new Error('gone');
    if (u.status !== 'active') return res.status(403).json({ error: 'This account has been suspended. Please contact support.' });
    req.user = u;
    if (u.role === 'doctor') req.doctor = await get('SELECT * FROM doctors WHERE user_id=?', [u.id]);
    next();
  } catch { res.status(401).json({ error: 'Please sign in to continue.' }); }
};
const role = (...r) => (req, res, next) => r.includes(req.user.role) ? next() : res.status(403).json({ error: 'You do not have access to this area.' });

async function loadAppt(req, res) {
  const a = await get(`${APPT_SQL} WHERE a.id=?`, [req.params.id]);
  if (!a) { res.status(404).json({ error: 'Appointment not found.' }); return null; }
  const u = req.user;
  if (!(u.role === 'admin' || a.user_id === u.id || a.doctor_user_id === u.id)) { res.status(403).json({ error: 'You do not have access to this appointment.' }); return null; }
  return a;
}

/* ------------------------------------------------------------ public */
app.get('/api/health', async (_, res) => res.json({ ok: true, service: 'HealthSync API', ai: AI.llmEnabled() ? 'claude' : 'built-in' }));
app.get('/api/public/settings', async (_, res) => res.json({ clinic_name: await getSetting('clinic_name'), platform_fee: +await getSetting('platform_fee', 0), banner: await getSetting('maintenance_banner'), allow_registration: await getSetting('allow_registration', '1') === '1', cancellation_hours: +await getSetting('cancellation_hours', 4), ai: AI.llmEnabled() ? 'claude' : 'built-in' }));
app.get('/api/public/stats', async (_, res) => {
  const c = async q => await get(q).c;
  const reviews = await all("SELECT r.rating, r.comment, u.name patient, du.name doctor FROM reviews r JOIN users u ON u.id=r.user_id JOIN doctors d ON d.id=r.doctor_id JOIN users du ON du.id=d.user_id WHERE r.status='visible' AND r.rating>=4 AND LENGTH(r.comment)>25 ORDER BY r.created_at DESC LIMIT 3")
    .map(r => ({ ...r, patient: r.patient.split(' ')[0] + ' ' + (r.patient.split(' ')[1]?.[0] || '') + '.' }));
  res.json({ doctors: await c("SELECT COUNT(*) c FROM doctors WHERE status='approved'"), specialties: await c("SELECT COUNT(DISTINCT specialty) c FROM doctors WHERE status='approved'"), consultations: await c("SELECT COUNT(*) c FROM appointments WHERE status='completed'"), rating: +(await get("SELECT AVG(rating) a FROM reviews WHERE status='visible'").a || 0).toFixed(1), reviews });
});
app.get('/api/specialties', async (_, res) => res.json(await all("SELECT specialty name, COUNT(*) doctors FROM doctors WHERE status='approved' GROUP BY specialty ORDER BY specialty")));

app.get('/api/doctors', async (req, res) => {
  const { q = '', specialty, sort = 'recommended', maxFee, minRating, mode, city, today, language } = req.query;
  let list = await all(`${DOC_SQL} WHERE d.status='approved' AND u.status='active'`).map(docOut);
  if (specialty && specialty !== 'All') list = list.filter(d => d.specialty === specialty);
  if (q) { const s = String(q).toLowerCase(); list = list.filter(d => [d.name, d.specialty, d.bio, d.city, d.clinic, d.qualifications].join(' ').toLowerCase().includes(s)); }
  if (maxFee) list = list.filter(d => d.fee <= +maxFee);
  if (minRating) list = list.filter(d => d.rating >= +minRating);
  if (mode && mode !== 'Any') list = list.filter(d => d.modes.includes(mode));
  if (city && city !== 'Any') list = list.filter(d => d.city === city);
  if (language && language !== 'Any') list = list.filter(d => d.languages.includes(language));
  list = await Promise.all(list.map(async d => ({ ...d, next: await AI.nextSlot({ ...d, schedule: JSON.stringify(d.schedule), leave_dates: JSON.stringify(d.leave_dates) }) })));
  if (today === '1') list = list.filter(d => d.next?.date === ymd());
  const sorters = { rating: (a, b) => b.rating - a.rating, fee_low: (a, b) => a.fee - b.fee, fee_high: (a, b) => b.fee - a.fee, experience: (a, b) => b.experience - a.experience, soonest: (a, b) => (a.next ? a.next.date + a.next.time : 'z').localeCompare(b.next ? b.next.date + b.next.time : 'z'), recommended: (a, b) => (b.rating * 10 + Math.min(b.reviews_count, 20) / 4) - (a.rating * 10 + Math.min(a.reviews_count, 20) / 4) };
  list.sort(sorters[sort] || sorters.recommended);
  res.json(list.map(({ schedule, leave_dates, email, phone, ...d }) => d));
});
app.get('/api/doctors/filters', async (_, res) => {
  const docs = await all("SELECT city, languages FROM doctors WHERE status='approved'");
  res.json({ cities: [...new Set(docs.map(d => d.city).filter(Boolean))].sort(), languages: [...new Set(docs.flatMap(d => String(d.languages).split(',')))].sort() });
});
app.get('/api/doctors/:id', async (req, res) => {
  const d = await get(`${DOC_SQL} WHERE d.id=? AND d.status='approved'`, [req.params.id]);
  if (!d) return res.status(404).json({ error: 'Doctor not found.' });
  const reviews = await all("SELECT r.rating, r.comment, r.created_at, u.name patient FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.doctor_id=? AND r.status='visible' ORDER BY r.created_at DESC LIMIT 20", [d.id]).map(r => ({ ...r, patient: r.patient.split(' ')[0] + ' ' + (r.patient.split(' ')[1]?.[0] || '') + '.' }));
  const dist = [5, 4, 3, 2, 1].map(n => ({ stars: n, count: reviews.filter(r => r.rating === n).length }));
  const { email, phone, ...out } = docOut(d);
  res.json({ ...out, reviews, distribution: dist, patients_served: await get("SELECT COUNT(DISTINCT user_id) c FROM appointments WHERE doctor_id=? AND status='completed'", [d.id]).c });
});
app.get('/api/doctors/:id/slots', async (req, res) => {
  const d = await get('SELECT * FROM doctors WHERE id=? AND status=\'approved\'', [req.params.id]);
  if (!d) return res.status(404).json({ error: 'Doctor not found.' });
  const days = Math.min(+req.query.days || 14, 45); const out = {};
  for (let i = 0; i < days; i++) { const date = ymd(addDays(new Date(), i)); out[date] = await AI.slotsForDate(d, date); }
  res.json(out);
});
app.get('/api/coupons/validate', async (req, res) => {
  const c = await get('SELECT * FROM coupons WHERE code=? AND active=1', [String(req.query.code || '').toUpperCase()]);
  c ? res.json({ code: c.code, percent: c.percent, description: c.description }) : res.status(404).json({ error: 'That coupon is not valid.' });
});

/* ------------------------------------------------------------ auth */
app.post('/api/auth/register', wrap(async (req, res) => {
  if (await getSetting('allow_registration', '1') !== '1') return res.status(403).json({ error: 'Registration is currently closed.' });
  const { name, email, password, phone = '', accountType = 'patient', specialty, qualifications, experience, fee, reg_no, city } = req.body;
  if (!name || !email || !password || password.length < 6 || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'A name, valid email and a password of 6+ characters are required.' });
  if (await get('SELECT id FROM users WHERE email=?', [email.toLowerCase()])) return res.status(409).json({ error: 'An account with that email already exists.' });
  const isDoc = accountType === 'doctor';
  if (isDoc && (!specialty || !reg_no)) return res.status(400).json({ error: 'Specialty and medical registration number are required for doctors.' });
  const hash = await bcrypt.hash(password, 10);
  const info = await run('INSERT INTO users (name,email,password,phone,role,city) VALUES (?,?,?,?,?,?)', [sanitize(name, 80), email.toLowerCase(), hash, sanitize(phone, 30), isDoc ? 'doctor' : 'patient', sanitize(city, 60)]);
  if (isDoc) {
    const sched = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map(d => [d, [['10:00', '13:00'], ['15:00', '17:00']]]));
    await run("INSERT INTO doctors (user_id,specialty,qualifications,experience,fee,city,schedule,status,reg_no,bio) VALUES (?,?,?,?,?,?,?, 'pending', ?, ?)", [info.lastInsertRowid, sanitize(specialty, 60), sanitize(qualifications, 160), +experience || 1, +fee || 500, sanitize(city, 60), JSON.stringify(sched), sanitize(reg_no, 40), 'New doctor on HealthSync.']);
    await all("SELECT id FROM users WHERE role='admin'").forEach(async a => await notify(a.id, 'Doctor application', `${name} (${specialty}) applied to join.`, 'admin', '/admin/doctors'));
  }
  const user = await get('SELECT * FROM users WHERE id=?', [info.lastInsertRowid]);
  await audit(user, 'register', `${user.role} account created`);
  await notify(user.id, 'Welcome to HealthSync', isDoc ? 'Your application is under review. You will be notified when approved.' : 'Your account is ready. Try the AI assistant or book your first consultation.', 'info');
  res.status(201).json({ user: publicUser(user), token: tokenFor(user) });
}));
app.post('/api/auth/login', wrap(async (req, res) => {
  const { email = '', password = '' } = req.body; const key = `${req.ip}|${email.toLowerCase()}`;
  if (limited(key)) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  const u = await get('SELECT * FROM users WHERE email=?', [email.toLowerCase()]);
  if (!u || !(await bcrypt.compare(password, u.password))) { attempts.set(key, [...(attempts.get(key) || []), Date.now()]); return res.status(401).json({ error: 'Email or password is incorrect.' }); }
  if (u.status !== 'active') return res.status(403).json({ error: 'This account has been suspended. Please contact support.' });
  await run('UPDATE users SET last_login=? WHERE id=?', [new Date().toISOString(), u.id]);
  await audit(u, 'login', u.role);
  res.json({ user: publicUser(u), token: tokenFor(u) });
}));
app.get('/api/me', auth, async (req, res) => res.json({ user: publicUser(req.user), doctor: req.doctor ? docOut(await get(`${DOC_SQL} WHERE d.id=?`, [req.doctor.id])) : null }));
app.patch('/api/me', auth, async (req, res) => {
  const b = req.body;
  await run('UPDATE users SET name=?, phone=?, gender=?, dob=?, blood_group=?, city=?, allergies=?, conditions=?, emergency_contact=? WHERE id=?', [sanitize(b.name || req.user.name, 80), sanitize(b.phone, 30), sanitize(b.gender, 20), sanitize(b.dob, 12), sanitize(b.blood_group, 5), sanitize(b.city, 60), sanitize(b.allergies, 200), sanitize(b.conditions, 200), sanitize(b.emergency_contact, 60), req.user.id]);
  res.json({ user: publicUser(await get('SELECT * FROM users WHERE id=?', [req.user.id])) });
});
app.post('/api/me/password', auth, wrap(async (req, res) => {
  const { current, next } = req.body;
  if (!next || next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  if (!(await bcrypt.compare(current || '', req.user.password))) return res.status(400).json({ error: 'Current password is incorrect.' });
  await run('UPDATE users SET password=? WHERE id=?', [await bcrypt.hash(next, 10), req.user.id]); await audit(req.user, 'password_change');
  res.json({ ok: true });
}));

/* profile photos: random, unguessable file names; only this folder is served publicly */
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });
const sniff = b => b.length > 12 && ((b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ? 'jpg' : (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ? 'png' : (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') ? 'webp' : null);
app.use('/uploads/avatars', express.static(avatarDir, { maxAge: '7d', index: false, dotfiles: 'deny' }));
const dropPhoto = u => { if (u.photo) fs.rm(path.join(avatarDir, path.basename(u.photo)), () => { }); };
app.post('/api/me/photo', auth, photoUpload.single('photo'), async (req, res) => {
  const ext = req.file && sniff(req.file.buffer);
  if (!ext) return res.status(400).json({ error: 'Please choose a JPG, PNG or WebP image (max 3 MB).' });
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(avatarDir, name), req.file.buffer); dropPhoto(req.user);
  await run('UPDATE users SET photo=? WHERE id=?', [`/uploads/avatars/${name}`, req.user.id]);
  res.json({ user: publicUser(await get('SELECT * FROM users WHERE id=?', [req.user.id])) });
});
app.delete('/api/me/photo', auth, async (req, res) => { dropPhoto(req.user); await run("UPDATE users SET photo='' WHERE id=?", [req.user.id]); res.json({ user: publicUser(await get('SELECT * FROM users WHERE id=?', [req.user.id])) }); });

/* ------------------------------------------------------------ notifications */
app.get('/api/notifications', auth, async (req, res) => res.json({ items: await all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 40', [req.user.id]), unread: await get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0', [req.user.id]).c }));
app.post('/api/notifications/read', auth, async (req, res) => { await run('UPDATE notifications SET read=1 WHERE user_id=?', [req.user.id]); res.json({ ok: true }); });

/* ------------------------------------------------------------ appointments */
app.post('/api/appointments', auth, role('patient'), wrap(async (req, res) => {
  const { doctorId, date, time, mode = 'Video', reason = '', coupon = '', method = 'online', triage = '' } = req.body;
  const doc = await get("SELECT d.*, u.name FROM doctors d JOIN users u ON u.id=d.user_id WHERE d.id=? AND d.status='approved'", [doctorId]);
  if (!doc) return res.status(404).json({ error: 'Doctor not found.' });
  if (!date || !time) return res.status(400).json({ error: 'Please choose a date and time.' });
  if (!doc.modes.split(',').includes(mode)) return res.status(400).json({ error: `${doc.name} does not offer ${mode} consultations.` });
  if (!(await AI.slotsForDate(doc, date)).includes(time)) return res.status(409).json({ error: 'That slot was just taken or is unavailable. Please pick another time.' });
  if (await get("SELECT id FROM appointments WHERE user_id=? AND date=? AND time=? AND status='confirmed'", [req.user.id, date, time])) return res.status(409).json({ error: 'You already have an appointment at that time.' });
  let discount = 0, code = '';
  if (coupon) { const c = await get('SELECT * FROM coupons WHERE code=? AND active=1', [coupon.toUpperCase()]); if (c) { discount = Math.round(doc.fee * c.percent / 100); code = c.code; await run('UPDATE coupons SET uses=uses+1 WHERE code=?', [c.code]); } }
  const platform = +await getSetting('platform_fee', 0);
  const info = await run('INSERT INTO appointments (user_id,doctor_id,date,time,mode,reason,status,fee,discount,platform_fee,coupon,payment_status,payment_method,ai_triage) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [req.user.id, doc.id, date, time, mode, sanitize(reason, 500), 'confirmed', doc.fee, discount, platform, code, method === 'online' ? 'paid' : 'pending', method, sanitize(triage, 1000)]);
  await notify(doc.user_id, 'New booking', `${req.user.name} booked a ${mode.toLowerCase()} consultation on ${date} at ${time}.`, 'appointment', '/doctor/schedule');
  await notify(req.user.id, 'Appointment confirmed', `${mode} consultation with ${doc.name} on ${date} at ${time}.`, 'appointment', '/patient/appointments');
  await audit(req.user, 'booking', `#${info.lastInsertRowid} with ${doc.name}`);
  res.status(201).json({ appointment: apptOut(await get(`${APPT_SQL} WHERE a.id=?`, [info.lastInsertRowid])) });
}));
app.get('/api/appointments', auth, async (req, res) => {
  const { status } = req.query; const u = req.user;
  const where = u.role === 'patient' ? 'a.user_id=?' : u.role === 'doctor' ? 'a.doctor_id=?' : '1=1';
  const params = u.role === 'patient' ? [u.id] : u.role === 'doctor' ? [req.doctor.id] : [];
  const rows = await all(`${APPT_SQL} WHERE ${where} ${status ? 'AND a.status=?' : ''} ORDER BY a.date DESC, a.time DESC LIMIT 500`, status ? [...params, status] : params).map(apptOut);
  const reviewed = new Set(await all('SELECT appointment_id FROM reviews').map(r => r.appointment_id));
  res.json(rows.map(a => ({ ...a, reviewed: reviewed.has(a.id) })));
});
app.get('/api/appointments/:id', auth, async (req, res) => {
  const a = await loadAppt(req, res); if (!a) return;
  const patient = await get('SELECT id,name,photo,email,phone,gender,dob,blood_group,city,allergies,conditions,emergency_contact FROM users WHERE id=?', [a.user_id]);
  const rx = await all('SELECT * FROM prescriptions WHERE appointment_id=?', [a.id]).map(p => ({ ...p, medicines: J(p.medicines, []) }));
  res.json({ appointment: apptOut(a), patient: req.user.role === 'patient' ? undefined : patient, prescriptions: rx, review: await get('SELECT * FROM reviews WHERE appointment_id=?', [a.id]) || null });
});
app.patch('/api/appointments/:id/cancel', auth, async (req, res) => {
  const a = await loadAppt(req, res); if (!a) return;
  if (a.status !== 'confirmed') return res.status(400).json({ error: 'Only upcoming appointments can be cancelled.' });
  if (req.user.role === 'patient') {
    const hrs = (new Date(`${a.date}T${a.time}:00`) - Date.now()) / 36e5; const lim = +await getSetting('cancellation_hours', 4);
    if (hrs < lim) return res.status(400).json({ error: `Appointments can be cancelled up to ${lim} hours before the start time.` });
  }
  await run("UPDATE appointments SET status='cancelled', payment_status=CASE WHEN payment_status='paid' THEN 'refunded' ELSE payment_status END WHERE id=?", [a.id]);
  const other = req.user.id === a.user_id ? a.doctor_user_id : a.user_id;
  await notify(other, 'Appointment cancelled', `${req.user.name} cancelled the ${a.date} ${a.time} appointment.`, 'appointment');
  await audit(req.user, 'cancel', `#${a.id}`);
  res.json({ ok: true });
});
app.patch('/api/appointments/:id/reschedule', auth, async (req, res) => {
  const a = await loadAppt(req, res); if (!a) return;
  const { date, time } = req.body; const doc = await get('SELECT * FROM doctors WHERE id=?', [a.doctor_id]);
  if (a.status !== 'confirmed') return res.status(400).json({ error: 'Only upcoming appointments can be rescheduled.' });
  if (!(await AI.slotsForDate(doc, date)).includes(time)) return res.status(409).json({ error: 'That slot is not available.' });
  await run('UPDATE appointments SET date=?, time=? WHERE id=?', [date, time, a.id]);
  const other = req.user.id === a.user_id ? a.doctor_user_id : a.user_id;
  await notify(other, 'Appointment rescheduled', `Now on ${date} at ${time}.`, 'appointment');
  res.json({ ok: true });
});
app.patch('/api/appointments/:id/status', auth, role('doctor', 'admin'), async (req, res) => {
  const a = await loadAppt(req, res); if (!a) return;
  const { status } = req.body;
  if (!['confirmed', 'completed', 'no-show', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  if (status === 'completed' && req.user.role === 'doctor' && !await get('SELECT id FROM prescriptions WHERE appointment_id=?', [a.id])) return res.status(400).json({ error: 'Issue and sign a prescription before completing this consultation.' });
  await run("UPDATE appointments SET status=?, payment_status=CASE WHEN ?='cancelled' AND payment_status='paid' THEN 'refunded' WHEN ?='completed' AND payment_method='later' THEN 'paid' ELSE payment_status END WHERE id=?", [status, status, status, a.id]);
  if (status === 'completed') await notify(a.user_id, 'Consultation complete', `Your visit with ${a.doctor_name} is complete. Please rate your experience.`, 'review', '/patient/appointments');
  if (status === 'cancelled') await notify(a.user_id, 'Appointment cancelled by doctor', `${a.doctor_name} cancelled the ${a.date} ${a.time} appointment. A refund (if paid) is on its way.`, 'appointment');
  await audit(req.user, 'appointment_status', `#${a.id} → ${status}`);
  res.json({ ok: true });
});
app.put('/api/appointments/:id/notes', auth, role('doctor', 'admin'), async (req, res) => {
  const a = await loadAppt(req, res); if (!a) return;
  const { soap, diagnosis = '', follow_up = '' } = req.body;
  await run('UPDATE appointments SET soap=?, diagnosis=?, follow_up=? WHERE id=?', [JSON.stringify(soap || {}), sanitize(diagnosis, 300), sanitize(follow_up, 12), a.id]);
  res.json({ ok: true });
});
app.post('/api/appointments/:id/review', auth, role('patient'), async (req, res) => {
  const a = await loadAppt(req, res); if (!a) return;
  if (a.status !== 'completed') return res.status(400).json({ error: 'You can review a consultation once it is complete.' });
  if (await get('SELECT id FROM reviews WHERE appointment_id=?', [a.id])) return res.status(409).json({ error: 'You have already reviewed this consultation.' });
  const rating = Math.min(5, Math.max(1, +req.body.rating || 5));
  await run('INSERT INTO reviews (appointment_id,user_id,doctor_id,rating,comment,created_at) VALUES (?,?,?,?,?,?)', [a.id, req.user.id, a.doctor_id, rating, sanitize(req.body.comment, 600), ymd()]);
  await recalcRating(a.doctor_id); await notify(a.doctor_user_id, 'New review', `${req.user.name.split(' ')[0]} left you ${rating} star${rating > 1 ? 's' : ''}.`, 'review', '/doctor/reviews');
  res.status(201).json({ ok: true });
});

/* chat + call signalling */
app.get('/api/appointments/:id/messages', auth, async (req, res) => {
  const a = await loadAppt(req, res); if (!a) return;
  const after = +req.query.after || 0;
  res.json(await all('SELECT m.*, u.name sender_name, u.role sender_role FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.appointment_id=? AND m.id>? ORDER BY m.id', [a.id, after]));
});
app.post('/api/appointments/:id/messages', auth, async (req, res) => {
  const a = await loadAppt(req, res); if (!a) return;
  if (req.user.role === 'admin') return res.status(403).json({ error: 'Admins cannot post in consultations.' });
  if (a.status === 'cancelled') return res.status(400).json({ error: 'This appointment was cancelled.' });
  const body = sanitize(req.body.body, 2000); if (!body) return res.status(400).json({ error: 'Message is empty.' });
  const info = await run('INSERT INTO messages (appointment_id,sender_id,body) VALUES (?,?,?)', [a.id, req.user.id, body]);
  const other = req.user.id === a.user_id ? a.doctor_user_id : a.user_id;
  const unread = await get("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='message' AND read=0 AND link=?", [other, `/consult/${a.id}`]).c;
  if (!unread) await notify(other, 'New message', `${req.user.name}: ${body.slice(0, 80)}`, 'message', `/consult/${a.id}`);
  res.status(201).json(await get('SELECT m.*, u.name sender_name, u.role sender_role FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?', [info.lastInsertRowid]));
});
app.get('/api/threads', auth, role('patient', 'doctor'), async (req, res) => {
  const col = req.user.role === 'patient' ? 'a.user_id=?' : 'a.doctor_id=?'; const id = req.user.role === 'patient' ? req.user.id : req.doctor.id;
  const rows = await all(`${APPT_SQL} WHERE ${col} AND a.status!='cancelled' ORDER BY a.date DESC, a.time DESC LIMIT 60`, [id]);
  const threadRows = await Promise.all(rows.map(async a => { const last = await get('SELECT body, created_at, sender_id FROM messages WHERE appointment_id=? ORDER BY id DESC LIMIT 1', [a.id]); return { id: a.id, date: a.date, time: a.time, status: a.status, mode: a.mode, with: req.user.role === 'patient' ? a.doctor_name : a.patient_name, photo: req.user.role === 'patient' ? a.doctor_photo : a.patient_photo, gender: req.user.role === 'patient' ? a.doctor_gender : a.patient_gender, doctor: req.user.role === 'patient', color: a.color, specialty: a.specialty, last }; }));
  res.json(threadRows.sort((x, y) => (y.last?.created_at || '').localeCompare(x.last?.created_at || '')));
});
app.post('/api/appointments/:id/signal', auth, async (req, res) => {
  const a = await loadAppt(req, res); if (!a) return;
  if (req.user.role === 'admin') return res.status(403).json({ error: 'Not allowed.' });
  await run("DELETE FROM signals WHERE created_at < (CURRENT_TIMESTAMP - INTERVAL '15 minutes')::text");
  await run('INSERT INTO signals (appointment_id,from_user,kind,payload) VALUES (?,?,?,?)', [a.id, req.user.id, sanitize(req.body.kind, 20), JSON.stringify(req.body.payload ?? null)]);
  res.json({ ok: true });
});
app.get('/api/appointments/:id/signal', auth, async (req, res) => {
  const a = await loadAppt(req, res); if (!a) return;
  res.json(await all('SELECT id, from_user, kind, payload FROM signals WHERE appointment_id=? AND from_user!=? AND id>? ORDER BY id', [a.id, req.user.id, +req.query.after || 0]).map(s => ({ ...s, payload: J(s.payload, null) })));
});

/* ------------------------------------------------------------ patient */
app.get('/api/patient/dashboard', auth, role('patient'), async (req, res) => {
  const id = req.user.id; const appts = await all(`${APPT_SQL} WHERE a.user_id=? ORDER BY a.date, a.time`, [id]).map(apptOut);
  const upcoming = appts.filter(a => a.status === 'confirmed' && a.date >= ymd());
  const reviewedIds = new Set((await all('SELECT appointment_id FROM reviews')).map(r => r.appointment_id));
  const pending_reviews = appts.filter(a => a.status === 'completed' && !reviewedIds.has(a.id));
  const lastVitals = {}; for (const k of ['bp', 'heart_rate', 'weight', 'glucose']) { const v = await get('SELECT * FROM vitals WHERE user_id=? AND kind=? ORDER BY recorded_at DESC, id DESC LIMIT 1', [id, k]); if (v) lastVitals[k] = { ...v, ...AI.interpretVital(k, v.value, v.value2) }; }
  res.json({ upcoming, pending_reviews: pending_reviews.slice(-3), recent: appts.filter(a => a.status === 'completed').slice(-3).reverse(), reports: await get('SELECT COUNT(*) c FROM reports WHERE user_id=?', [id]).c, prescriptions: await get('SELECT COUNT(*) c FROM prescriptions WHERE user_id=?', [id]).c, visits: appts.filter(a => a.status === 'completed').length, vitals: lastVitals,
    favorites: await all(`${DOC_SQL} JOIN favorites f ON f.doctor_id=d.id WHERE f.user_id=? AND d.status='approved'`, [id]).map(async d => ({ id: d.id, name: d.name, photo: d.photo, gender: d.gender, specialty: d.specialty, color: d.color, rating: d.rating, fee: d.fee, next: await AI.nextSlot(d) }))  });
});
app.get('/api/favorites', auth, role('patient'), async (req, res) => res.json(await all('SELECT doctor_id FROM favorites WHERE user_id=?', [req.user.id]).map(f => f.doctor_id)));
app.post('/api/favorites/:doctorId', auth, role('patient'), async (req, res) => {
  const f = await get('SELECT 1 x FROM favorites WHERE user_id=? AND doctor_id=?', [req.user.id, req.params.doctorId]);
  f ? await run('DELETE FROM favorites WHERE user_id=? AND doctor_id=?', [req.user.id, req.params.doctorId]) : await run('INSERT INTO favorites (user_id,doctor_id) VALUES (?,?)', [req.user.id, req.params.doctorId]);
  res.json({ favorite: !f });
});
app.get('/api/prescriptions', auth, role('patient'), async (req, res) => res.json(await all('SELECT p.*, u.name doctor_name, d.specialty, d.reg_no FROM prescriptions p JOIN doctors d ON d.id=p.doctor_id JOIN users u ON u.id=d.user_id WHERE p.user_id=? ORDER BY p.issued_at DESC, p.id DESC', [req.user.id]).map(p => ({ ...p, medicines: J(p.medicines, []) }))));
app.get('/api/vitals', auth, role('patient'), async (req, res) => res.json(await all('SELECT * FROM vitals WHERE user_id=? ORDER BY recorded_at ASC, id ASC', [req.user.id])));
app.post('/api/vitals', auth, role('patient'), async (req, res) => {
  const { kind, value, value2, when } = req.body;
  if (!['bp', 'heart_rate', 'weight', 'glucose', 'temperature', 'spo2'].includes(kind) || !isFinite(+value) || value === '' || value === null) return res.status(400).json({ error: 'Please enter a valid reading.' });
  if (kind === 'bp' && (!isFinite(+value2) || value2 === '' || value2 === null)) return res.status(400).json({ error: 'Enter both systolic and diastolic values.' });
  await run('INSERT INTO vitals (user_id,kind,value,value2,recorded_at) VALUES (?,?,?,?,?)', [req.user.id, kind, +value, kind === 'bp' ? +value2 : null, when || new Date().toISOString().slice(0, 19).replace('T', ' ')]);
  res.status(201).json({ ...AI.interpretVital(kind, +value, +value2) });
});
app.delete('/api/vitals/:id', auth, role('patient'), async (req, res) => { await run('DELETE FROM vitals WHERE id=? AND user_id=?', [req.params.id, req.user.id]); res.json({ ok: true }); });

/* reports (private, access-controlled) */
app.get('/api/reports', auth, role('patient'), async (req, res) => res.json(await all('SELECT id,name,type,size,category,uploaded_at,original_name FROM reports WHERE user_id=? ORDER BY uploaded_at DESC, id DESC', [req.user.id])));
app.post('/api/reports', auth, role('patient'), upload.single('report'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please choose a PDF, image or document (max 8 MB).' });
  const info = await run('INSERT INTO reports (user_id,name,file_name,original_name,type,size,category) VALUES (?,?,?,?,?,?,?)', [req.user.id, sanitize(req.body.name || req.file.originalname, 120), req.file.filename, sanitize(req.file.originalname, 120), req.file.mimetype, `${Math.max(1, Math.round(req.file.size / 1024))} KB`, sanitize(req.body.category || 'Lab report', 40)]);
  res.status(201).json({ report: await get('SELECT * FROM reports WHERE id=?', [info.lastInsertRowid]) });
});
app.delete('/api/reports/:id', auth, role('patient'), async (req, res) => {
  const r = await get('SELECT * FROM reports WHERE id=? AND user_id=?', [req.params.id, req.user.id]); if (!r) return res.status(404).json({ error: 'Not found.' });
  fs.rm(path.join(uploadDir, path.basename(r.file_name)), () => { }); await run('DELETE FROM reports WHERE id=?', [r.id]); res.json({ ok: true });
});
app.get('/api/reports/:id/file', auth, async (req, res) => {
  const r = await get('SELECT * FROM reports WHERE id=?', [req.params.id]); if (!r) return res.status(404).json({ error: 'Not found.' });
  const ok = req.user.role === 'admin' || r.user_id === req.user.id || (req.user.role === 'doctor' && await get('SELECT id FROM appointments WHERE doctor_id=? AND user_id=? AND status!=\'cancelled\'', [req.doctor?.id, r.user_id]));
  if (!ok) return res.status(403).json({ error: 'You do not have access to this file.' });
  const f = path.join(uploadDir, path.basename(r.file_name)); if (!fs.existsSync(f)) return res.status(404).json({ error: 'File missing.' });
  res.type(r.type || 'application/octet-stream'); res.setHeader('Content-Disposition', `inline; filename="${(r.original_name || r.name).replace(/[^\w.\- ]/g, '_')}"`); res.sendFile(f);
});

/* ------------------------------------------------------------ doctor */
const D = [auth, role('doctor')];
app.get('/api/doctor/dashboard', ...D, async (req, res) => {
  const d = req.doctor; const today = ymd();
  const appts = await all(`${APPT_SQL} WHERE a.doctor_id=? AND a.date>=? ORDER BY a.date, a.time`, [d.id, ymd(addDays(new Date(), -7))]).map(apptOut);
  const todays = appts.filter(a => a.date === today);
  const pending_notes = await all(`${APPT_SQL} WHERE a.doctor_id=? AND a.status='completed' AND (a.soap='' OR a.soap IS NULL) ORDER BY a.date DESC LIMIT 10`, [d.id]).map(apptOut);
  const month = today.slice(0, 7);
  const earnings = await get("SELECT COALESCE(SUM(fee-discount),0) c FROM appointments WHERE doctor_id=? AND payment_status='paid' AND status='completed' AND date LIKE ?", [d.id, `${month}%`]).c;
  const week = []; for (let i = 6; i >= 0; i--) { const dt = ymd(addDays(new Date(), -i)); week.push({ date: dt, count: await get("SELECT COUNT(*) c FROM appointments WHERE doctor_id=? AND date=? AND status IN ('completed','confirmed')", [d.id, dt]).c }); }
  res.json({ doctor: docOut(await get(`${DOC_SQL} WHERE d.id=?`, [d.id])), today: todays, upcoming: appts.filter(a => a.date > today && a.status === 'confirmed').slice(0, 8), next: todays.find(a => a.status === 'confirmed' && a.time >= new Date().toTimeString().slice(0, 5)) || todays.find(a => a.status === 'confirmed') || null, pending_notes,
    stats: { today: todays.filter(a => a.status !== 'cancelled').length, completed_today: todays.filter(a => a.status === 'completed').length, patients: await get("SELECT COUNT(DISTINCT user_id) c FROM appointments WHERE doctor_id=? AND status='completed'", [d.id]).c, earnings, rating: d.rating, reviews: d.reviews_count, upcoming: await get("SELECT COUNT(*) c FROM appointments WHERE doctor_id=? AND status='confirmed' AND date>=?", [d.id, today]).c }, week });
});
app.get('/api/doctor/patients', ...D, async (req, res) => {
  res.json(await all(`SELECT u.id, u.name, u.photo, u.email, u.phone, u.gender, u.dob, u.blood_group, u.city, u.allergies, u.conditions, COUNT(a.id) visits, MAX(a.date) last_visit, SUM(CASE WHEN a.status='confirmed' THEN 1 ELSE 0 END) upcoming FROM appointments a JOIN users u ON u.id=a.user_id WHERE a.doctor_id=? AND a.status!='cancelled' GROUP BY u.id ORDER BY last_visit DESC`, [req.doctor.id]));
});
app.get('/api/doctor/patients/:id', ...D, async (req, res) => {
  const has = await get("SELECT id FROM appointments WHERE doctor_id=? AND user_id=? AND status!='cancelled'", [req.doctor.id, req.params.id]);
  if (!has) return res.status(403).json({ error: 'You can only view patients you have an appointment with.' });
  const p = await get('SELECT id,name,photo,email,phone,gender,dob,blood_group,city,allergies,conditions,emergency_contact FROM users WHERE id=?', [req.params.id]);
  res.json({ patient: p, visits: await all(`${APPT_SQL} WHERE a.user_id=? AND a.doctor_id=? ORDER BY a.date DESC`, [p.id, req.doctor.id]).map(apptOut), prescriptions: await all('SELECT * FROM prescriptions WHERE user_id=? ORDER BY issued_at DESC', [p.id]).map(x => ({ ...x, medicines: J(x.medicines, []) })), reports: await all('SELECT id,name,category,size,uploaded_at FROM reports WHERE user_id=? ORDER BY uploaded_at DESC', [p.id]), vitals: await all('SELECT * FROM vitals WHERE user_id=? ORDER BY recorded_at ASC', [p.id]), brief: await AI.patientBrief(p.id, req.doctor.id) });
});
app.put('/api/doctor/profile', ...D, async (req, res) => {
  const b = req.body; const d = req.doctor; const sched = b.schedule && typeof b.schedule === 'object' ? b.schedule : J(d.schedule, {});
  await run('UPDATE doctors SET fee=?, bio=?, modes=?, schedule=?, leave_dates=?, slot_minutes=?, languages=?, clinic=?, city=?, qualifications=?, experience=? WHERE id=?', [Math.max(0, +b.fee || d.fee), sanitize(b.bio ?? d.bio, 600), (b.modes || d.modes.split(',')).join(','), JSON.stringify(sched), JSON.stringify(b.leave_dates || J(d.leave_dates, [])), [15, 20, 30, 45, 60].includes(+b.slot_minutes) ? +b.slot_minutes : d.slot_minutes, (b.languages || d.languages.split(',')).join(','), sanitize(b.clinic ?? d.clinic, 100), sanitize(b.city ?? d.city, 60), sanitize(b.qualifications ?? d.qualifications, 160), +b.experience || d.experience, d.id]);
  await audit(req.user, 'doctor_profile', 'updated schedule/profile');
  res.json({ doctor: docOut(await get(`${DOC_SQL} WHERE d.id=?`, [d.id])) });
});
app.get('/api/doctor/earnings', ...D, async (req, res) => {
  const months = []; for (let i = 5; i >= 0; i--) { const dt = new Date(); dt.setDate(1); dt.setMonth(dt.getMonth() - i); const m = ymd(dt).slice(0, 7); const r = await get("SELECT COALESCE(SUM(fee-discount),0) amt, COUNT(*) n FROM appointments WHERE doctor_id=? AND status='completed' AND payment_status='paid' AND date LIKE ?", [req.doctor.id, `${m}%`]); months.push({ month: m, label: dt.toLocaleDateString('en-US', { month: 'short' }), amount: r.amt, visits: r.n }); }
  res.json({ months, pending: await get("SELECT COALESCE(SUM(fee-discount),0) c FROM appointments WHERE doctor_id=? AND status='confirmed' AND payment_status='paid'", [req.doctor.id]).c, recent: await all(`${APPT_SQL} WHERE a.doctor_id=? AND a.status='completed' ORDER BY a.date DESC LIMIT 15`, [req.doctor.id]).map(apptOut) });
});
app.get('/api/doctor/reviews', ...D, async (req, res) => res.json(await all("SELECT r.*, u.name patient FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.doctor_id=? AND r.status='visible' ORDER BY r.created_at DESC", [req.doctor.id])));
app.post('/api/prescriptions', ...D, async (req, res) => {
  const { appointmentId, diagnosis = '', medicines = [], instructions = '', follow_up = '', signature = '' } = req.body;
  const a = await get('SELECT * FROM appointments WHERE id=? AND doctor_id=?', [appointmentId, req.doctor.id]); if (!a) return res.status(404).json({ error: 'Appointment not found.' });
  if (a.status === 'cancelled') return res.status(400).json({ error: 'This appointment was cancelled.' });
  const meds = (Array.isArray(medicines) ? medicines : []).filter(m => m.name?.trim()).map(m => ({ name: sanitize(m.name, 80), dose: sanitize(m.dose, 40), frequency: sanitize(m.frequency, 80), days: +m.days || 0 }));
  if (!meds.length && sanitize(instructions).length < 3) return res.status(400).json({ error: 'Add at least one medicine, or written advice for the patient.' });
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature) || signature.length < 1200 || signature.length > 400000) return res.status(400).json({ error: 'Your signature is required. Please sign in the box using your mouse or touchpad.' });
  const info = await run('INSERT INTO prescriptions (appointment_id,user_id,doctor_id,diagnosis,medicines,instructions,follow_up,signature,issued_at) VALUES (?,?,?,?,?,?,?,?,?)', [a.id, a.user_id, req.doctor.id, sanitize(diagnosis, 300), JSON.stringify(meds), sanitize(instructions, 800), sanitize(follow_up, 12), signature, ymd()]);
  await notify(a.user_id, 'Prescription ready', `${req.user.name} issued and signed your prescription.`, 'prescription', '/patient/records?tab=prescriptions');
  await audit(req.user, 'prescription', `#${info.lastInsertRowid} for appointment #${a.id}`);
  res.status(201).json({ id: info.lastInsertRowid });
});

/* ------------------------------------------------------------ AI */
const logAI = async (u, kind, urgency = '') => await run('INSERT INTO ai_logs (user_id,kind,urgency) VALUES (?,?,?)', [u.id, kind, urgency]);
app.post('/api/ai/chat', auth, role('patient'), wrap(async (req, res) => {
  const messages = (req.body.messages || []).slice(-12).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: sanitize(m.content, 1500) }));
  if (!messages.length) return res.status(400).json({ error: 'Say something first.' });
  const out = await AI.patientChat({ messages, user: req.user }); await logAI(req.user, 'chat', out.urgency || ''); res.json(out);
}));
app.post('/api/ai/triage', auth, role('patient'), async (req, res) => {
  const { symptoms = '', age, duration = '', severity = '' } = req.body;
  if (sanitize(symptoms).length < 3) return res.status(400).json({ error: 'Please describe your symptoms.' });
  const out = await AI.triage({ text: symptoms, age, duration, severity }); await logAI(req.user, 'triage', out.urgency); res.json(out);
});
app.post('/api/ai/soap', ...D, wrap(async (req, res) => {
  const a = req.body.appointmentId ? await get(`${APPT_SQL} WHERE a.id=? AND a.doctor_id=?`, [req.body.appointmentId, req.doctor.id]) : null;
  const patient = a ? await get('SELECT * FROM users WHERE id=?', [a.user_id]) : null;
  const out = await AI.soapFromNotes({ notes: sanitize(req.body.notes, 4000), appointment: a, patient }); await logAI(req.user, 'soap'); res.json(out);
}));
app.post('/api/ai/rx', ...D, async (req, res) => {
  const patient = req.body.patientId ? await get('SELECT allergies FROM users WHERE id=?', [req.body.patientId]) : null;
  await logAI(req.user, 'rx'); res.json(AI.suggestRx({ diagnosis: sanitize(req.body.diagnosis, 300), allergies: patient?.allergies || '' }));
});
app.get('/api/ai/brief/:patientId', ...D, async (req, res) => {
  if (!await get("SELECT id FROM appointments WHERE doctor_id=? AND user_id=? AND status!='cancelled'", [req.doctor.id, req.params.patientId])) return res.status(403).json({ error: 'No access.' });
  await logAI(req.user, 'brief'); res.json(await AI.patientBrief(+req.params.patientId, req.doctor.id));
});

/* ------------------------------------------------------------ admin */
const ADM = [auth, role('admin')];
const snapshot = async () => ({
  total: await get('SELECT COUNT(*) c FROM appointments').c, patients: await get("SELECT COUNT(*) c FROM users WHERE role='patient'").c, doctors: await get("SELECT COUNT(*) c FROM doctors WHERE status='approved'").c,
  cancelled: await get("SELECT COUNT(*) c FROM appointments WHERE status='cancelled'").c, noShow: await get("SELECT COUNT(*) c FROM appointments WHERE status='no-show'").c,
  revenueMonth: await get("SELECT COALESCE(SUM(fee+platform_fee-discount),0) c FROM appointments WHERE payment_status='paid' AND date LIKE ?", [`${ymd().slice(0, 7)}%`]).c,
  bookings30: await get("SELECT COUNT(*) c FROM appointments WHERE date>=? AND status!='cancelled'", [ymd(addDays(new Date(), -30))]).c,
  pendingDoctors: await get("SELECT COUNT(*) c FROM doctors WHERE status='pending'").c,
  topDoctors: await all("SELECT u.name, COUNT(*) c FROM appointments a JOIN doctors d ON d.id=a.doctor_id JOIN users u ON u.id=d.user_id WHERE a.status='completed' GROUP BY d.id, u.name ORDER BY c DESC LIMIT 3")
});
app.get('/api/admin/overview', ...ADM, async (req, res) => {
  const today = ymd(); const m = today.slice(0, 7);
  const rev = async (cond, p = []) => await get(`SELECT COALESCE(SUM(fee+platform_fee-discount),0) c FROM appointments WHERE payment_status='paid' AND ${cond}`, p).c;
  const series = []; for (let i = 29; i >= 0; i--) { const dt = ymd(addDays(new Date(), -i)); series.push({ date: dt, bookings: await get("SELECT COUNT(*) c FROM appointments WHERE date=? AND status!='cancelled'", [dt]).c, revenue: await rev('date=?', [dt]) }); }
  const lastM = new Date(); lastM.setDate(1); lastM.setMonth(lastM.getMonth() - 1); const prev = ymd(lastM).slice(0, 7);
  res.json({
    kpis: { revenue_month: await rev('date LIKE ?', [`${m}%`]), revenue_prev: await rev('date LIKE ?', [`${prev}%`]), appointments_today: await get("SELECT COUNT(*) c FROM appointments WHERE date=? AND status!='cancelled'", [today]).c, patients: await get("SELECT COUNT(*) c FROM users WHERE role='patient'").c, doctors: await get("SELECT COUNT(*) c FROM doctors WHERE status='approved'").c, pending_doctors: await get("SELECT COUNT(*) c FROM doctors WHERE status='pending'").c, completion_rate: Math.round(100 * await get("SELECT COUNT(*) c FROM appointments WHERE status='completed'").c / Math.max(1, await get("SELECT COUNT(*) c FROM appointments WHERE status IN ('completed','no-show','cancelled')").c)), avg_rating: +(await get("SELECT AVG(rating) a FROM reviews WHERE status='visible'").a || 0).toFixed(2), ai_assists: await get('SELECT COUNT(*) c FROM ai_logs').c, new_patients_30: await get("SELECT COUNT(*) c FROM users WHERE role='patient' AND created_at>=?", [ymd(addDays(new Date(), -30))]).c },
    series, by_status: await all('SELECT status name, COUNT(*) value FROM appointments GROUP BY status'), by_specialty: await all("SELECT d.specialty name, COUNT(*) value FROM appointments a JOIN doctors d ON d.id=a.doctor_id WHERE a.status!='cancelled' GROUP BY d.specialty ORDER BY value DESC"), by_mode: await all("SELECT mode name, COUNT(*) value FROM appointments WHERE status!='cancelled' GROUP BY mode"),
    top_doctors: await all("SELECT u.name, d.specialty, d.rating, COUNT(*) visits, SUM(a.fee-a.discount) earned FROM appointments a JOIN doctors d ON d.id=a.doctor_id JOIN users u ON u.id=d.user_id WHERE a.status='completed' GROUP BY d.id, u.name ORDER BY visits DESC LIMIT 5"),
    recent: await all(`${APPT_SQL} ORDER BY a.id DESC LIMIT 8`).map(apptOut), ai_by_kind: await all('SELECT kind name, COUNT(*) value FROM ai_logs GROUP BY kind')
  });
});
app.get('/api/ai/admin/insights', ...ADM, async (req, res) => { await logAI(req.user, 'insights'); res.json(await AI.adminInsights()); });
app.post('/api/ai/admin/ask', ...ADM, wrap(async (req, res) => { await logAI(req.user, 'admin_ask'); res.json(await AI.adminAsk(sanitize(req.body.question, 300), await snapshot())); }));

app.get('/api/admin/users', ...ADM, async (req, res) => res.json(await all("SELECT u.id,u.name,u.email,u.phone,u.role,u.status,u.city,u.last_login,u.created_at,(SELECT COUNT(*) FROM appointments a WHERE a.user_id=u.id) appointments FROM users u ORDER BY u.id DESC")));
app.post('/api/admin/users', ...ADM, wrap(async (req, res) => {
  const { name, email, password, role: r = 'patient', phone = '' } = req.body;
  if (!name || !email || !password || password.length < 6 || !['patient', 'admin'].includes(r)) return res.status(400).json({ error: 'Name, email, role (patient/admin) and 6+ character password are required. Doctors are added from the Doctors page.' });
  if (await get('SELECT id FROM users WHERE email=?', [email.toLowerCase()])) return res.status(409).json({ error: 'Email already in use.' });
  const info = await run('INSERT INTO users (name,email,password,phone,role) VALUES (?,?,?,?,?)', [sanitize(name, 80), email.toLowerCase(), await bcrypt.hash(password, 10), sanitize(phone, 30), r]);
  await audit(req.user, 'user_create', `${email} (${r})`); res.status(201).json({ id: info.lastInsertRowid });
}));
app.patch('/api/admin/users/:id', ...ADM, wrap(async (req, res) => {
  const u = await get('SELECT * FROM users WHERE id=?', [req.params.id]); if (!u) return res.status(404).json({ error: 'User not found.' });
  if (u.id === req.user.id && req.body.status === 'suspended') return res.status(400).json({ error: 'You cannot suspend your own account.' });
  if (req.body.status) await run('UPDATE users SET status=? WHERE id=?', [req.body.status === 'suspended' ? 'suspended' : 'active', u.id]);
  if (req.body.name) await run('UPDATE users SET name=?, phone=?, city=? WHERE id=?', [sanitize(req.body.name, 80), sanitize(req.body.phone ?? u.phone, 30), sanitize(req.body.city ?? u.city, 60), u.id]);
  if (req.body.password) { if (req.body.password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters.' }); await run('UPDATE users SET password=? WHERE id=?', [await bcrypt.hash(req.body.password, 10), u.id]); }
  await audit(req.user, 'user_update', `${u.email}: ${Object.keys(req.body).filter(k => k !== 'password').join(', ')}${req.body.password ? ', password reset' : ''}`); res.json({ ok: true });
}));
app.post('/api/admin/users/:id/temp-password', ...ADM, wrap(async (req, res) => {
  const u = await get('SELECT * FROM users WHERE id=?', [req.params.id]); if (!u) return res.status(404).json({ error: 'User not found.' });
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; const temp = Array.from(crypto.randomBytes(10), b => chars[b % chars.length]).join('') + '#7';
  await run('UPDATE users SET password=? WHERE id=?', [await bcrypt.hash(temp, 10), u.id]);
  await notify(u.id, 'Your password was reset', 'An administrator set a new temporary password. Please change it from Profile & security after signing in.', 'info', '/doctor/profile');
  await audit(req.user, 'temp_password', u.email); res.json({ password: temp });
}));
app.delete('/api/admin/users/:id', ...ADM, async (req, res) => {
  const u = await get('SELECT * FROM users WHERE id=?', [req.params.id]); if (!u) return res.status(404).json({ error: 'Not found.' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  if (u.role === 'doctor') { const d = await get('SELECT id FROM doctors WHERE user_id=?', [u.id]); if (d) { await run('UPDATE appointments SET status=\'cancelled\' WHERE doctor_id=? AND status=\'confirmed\'', [d.id]); await run('UPDATE doctors SET status=\'suspended\' WHERE id=?', [d.id]); } }
  await run('UPDATE appointments SET status=\'cancelled\' WHERE user_id=? AND status=\'confirmed\'', [u.id]);
  await run('UPDATE users SET status=\'suspended\' WHERE id=?', [u.id]); await audit(req.user, 'user_deactivate', u.email); res.json({ ok: true });
});

app.get('/api/admin/doctors', ...ADM, async (req, res) => res.json(await all(`${DOC_SQL} ORDER BY CASE d.status WHEN 'pending' THEN 0 ELSE 1 END, d.id DESC`).map(async d => ({ ...docOut(d), accountStatus: await get('SELECT status FROM users WHERE id=?', [d.user_id]).status, visits: await get("SELECT COUNT(*) c FROM appointments WHERE doctor_id=? AND status='completed'", [d.id]).c }))));
app.post('/api/admin/doctors', ...ADM, wrap(async (req, res) => {
  const { name, email, password, specialty, fee = 500, experience = 1, qualifications = '', city = '', reg_no = '' } = req.body;
  if (!name || !email || !password || password.length < 6 || !specialty) return res.status(400).json({ error: 'Name, email, 6+ char password and specialty are required.' });
  if (await get('SELECT id FROM users WHERE email=?', [email.toLowerCase()])) return res.status(409).json({ error: 'Email already in use.' });
  const uid = await run('INSERT INTO users (name,email,password,role,city) VALUES (?,?,?,?,?)', [sanitize(name, 80), email.toLowerCase(), await bcrypt.hash(password, 10), 'doctor', sanitize(city, 60)]).lastInsertRowid;
  const sched = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map(d => [d, [['10:00', '13:00'], ['15:00', '17:00']]]));
  const id = await run("INSERT INTO doctors (user_id,specialty,qualifications,experience,fee,city,schedule,status,reg_no,bio,color) VALUES (?,?,?,?,?,?,?,'approved',?,?,?)", [uid, sanitize(specialty, 60), sanitize(qualifications, 160), +experience, +fee, sanitize(city, 60), JSON.stringify(sched), sanitize(reg_no, 40), 'Experienced specialist at HealthSync.', ['#cfe1dc', '#e8d4bf', '#e1d8ed', '#f0dfbd', '#f0dcda'][uid % 5]]).lastInsertRowid;
  await audit(req.user, 'doctor_create', name); res.status(201).json({ id });
}));
app.patch('/api/admin/doctors/:id', ...ADM, async (req, res) => {
  const d = await get('SELECT * FROM doctors WHERE id=?', [req.params.id]); if (!d) return res.status(404).json({ error: 'Not found.' });
  const b = req.body;
  if (b.status && ['approved', 'pending', 'suspended'].includes(b.status)) { await run('UPDATE doctors SET status=? WHERE id=?', [b.status, d.id]); if (b.status === 'approved') await notify(d.user_id, 'You are approved!', 'Your HealthSync doctor profile is now live. Set your availability to start receiving bookings.', 'info', '/doctor/availability'); if (b.status === 'suspended') await run("UPDATE appointments SET status='cancelled' WHERE doctor_id=? AND status='confirmed'", [d.id]); }
  if (b.fee !== undefined) await run('UPDATE doctors SET fee=?, specialty=?, experience=?, qualifications=?, city=? WHERE id=?', [+b.fee, sanitize(b.specialty ?? d.specialty, 60), +b.experience || d.experience, sanitize(b.qualifications ?? d.qualifications, 160), sanitize(b.city ?? d.city, 60), d.id]);
  await audit(req.user, 'doctor_update', `#${d.id} ${JSON.stringify(Object.keys(b))}`); res.json({ ok: true });
});
app.get('/api/admin/reviews', ...ADM, async (req, res) => res.json(await all('SELECT r.*, u.name patient, du.name doctor FROM reviews r JOIN users u ON u.id=r.user_id JOIN doctors d ON d.id=r.doctor_id JOIN users du ON du.id=d.user_id ORDER BY r.id DESC LIMIT 200')));
app.patch('/api/admin/reviews/:id', ...ADM, async (req, res) => { const r = await get('SELECT * FROM reviews WHERE id=?', [req.params.id]); if (!r) return res.status(404).json({ error: 'Not found.' }); await run('UPDATE reviews SET status=? WHERE id=?', [req.body.status === 'hidden' ? 'hidden' : 'visible', r.id]); await recalcRating(r.doctor_id); await audit(req.user, 'review_moderate', `#${r.id} ${req.body.status}`); res.json({ ok: true }); });
app.get('/api/admin/coupons', ...ADM, async (req, res) => res.json(await all('SELECT * FROM coupons ORDER BY code')));
app.post('/api/admin/coupons', ...ADM, async (req, res) => {
  const code = sanitize(req.body.code, 20).toUpperCase().replace(/\s/g, ''), pct = +req.body.percent;
  if (!code || !(pct > 0 && pct <= 90)) return res.status(400).json({ error: 'Provide a code and a discount between 1 and 90%.' });
  await run('INSERT INTO coupons (code,percent,description) VALUES (?,?,?) ON CONFLICT(code) DO UPDATE SET percent=excluded.percent, description=excluded.description', [code, pct, sanitize(req.body.description, 120)]); await audit(req.user, 'coupon', code); res.status(201).json({ ok: true });
});
app.patch('/api/admin/coupons/:code', ...ADM, async (req, res) => { await run('UPDATE coupons SET active=? WHERE code=?', [req.body.active ? 1 : 0, req.params.code]); res.json({ ok: true }); });
app.post('/api/admin/broadcast', ...ADM, async (req, res) => {
  const { audience = 'all', title, body = '' } = req.body; if (!title) return res.status(400).json({ error: 'A title is required.' });
  const users = await all(audience === 'all' ? "SELECT id FROM users WHERE role!='admin'" : 'SELECT id FROM users WHERE role=?', audience === 'all' ? [] : [audience === 'doctors' ? 'doctor' : 'patient']);
  for (const u of users) await notify(u.id, sanitize(title, 100), sanitize(body, 400), 'announcement'); await audit(req.user, 'broadcast', `${title} → ${users.length} users`); res.json({ sent: users.length });
});
app.get('/api/admin/audit', ...ADM, async (req, res) => res.json(await all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200')));
app.get('/api/admin/settings', ...ADM, async (req, res) => res.json({ clinic_name: await getSetting('clinic_name'), support_email: await getSetting('support_email'), platform_fee: +await getSetting('platform_fee', 0), cancellation_hours: +await getSetting('cancellation_hours', 4), allow_registration: await getSetting('allow_registration', '1') === '1', maintenance_banner: await getSetting('maintenance_banner'), ai_mode: AI.llmEnabled() ? 'claude' : 'built-in' }));
app.put('/api/admin/settings', ...ADM, async (req, res) => {
  const b = req.body; for (const k of ['clinic_name', 'support_email', 'maintenance_banner']) { if (b[k] !== undefined) await setSetting(k, sanitize(b[k], 200)); }
  if (b.platform_fee !== undefined) await setSetting('platform_fee', Math.max(0, +b.platform_fee || 0)); if (b.cancellation_hours !== undefined) await setSetting('cancellation_hours', Math.max(0, +b.cancellation_hours || 0)); if (b.allow_registration !== undefined) await setSetting('allow_registration', b.allow_registration ? 1 : 0);
  await audit(req.user, 'settings', 'platform settings updated'); res.json({ ok: true });
});
app.get('/api/admin/export/:what', ...ADM, async (req, res) => {
  const sets = { appointments: "SELECT a.id,a.date,a.time,a.mode,a.status,a.payment_status,a.fee,a.discount,a.platform_fee,pu.name patient,du.name doctor,d.specialty FROM appointments a JOIN doctors d ON d.id=a.doctor_id JOIN users du ON du.id=d.user_id JOIN users pu ON pu.id=a.user_id ORDER BY a.date DESC", users: 'SELECT id,name,email,phone,role,status,city,created_at FROM users', reviews: 'SELECT r.id,r.rating,r.comment,r.status,r.created_at FROM reviews r' };
  const q = sets[req.params.what]; if (!q) return res.status(404).json({ error: 'Unknown export.' });
  const rows = await all(q); const cols = rows[0] ? Object.keys(rows[0]) : [];
  const esc = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  res.type('text/csv'); res.setHeader('Content-Disposition', `attachment; filename="${req.params.what}-${ymd()}.csv"`);
  res.send([cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n'));
});

/* ------------------------------------------------------------ static client (production) */
const dist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(dist)) { app.use(express.static(dist)); app.get(/^\/(?!api).*/, async (_, res) => res.sendFile(path.join(dist, 'index.html'))); }
app.use('/api', async (_, res) => res.status(404).json({ error: 'Not found.' }));

app.listen(PORT, () => {
  console.log(`\nHealthSync API running at http://localhost:${PORT}  (AI: ${AI.llmEnabled() ? 'Claude' : 'built-in engine'})`);
  console.log('Demo logins →', Object.entries(CREDENTIALS).map(([r, c]) => `${r}: ${c.email} / ${c.password}`).join('  |  '));
});
