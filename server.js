'use strict';
/*
 * Lumina Attendance Server
 * Zero dependencies. Needs Node.js 22.13 or newer (uses the built-in SQLite).
 * Run:  node server.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_FINGERS = 127;           // template slots used on the sensor
const COMMAND_TIMEOUT = 180;       // seconds before an unfinished command fails
const ONLINE_WINDOW = 20;          // seconds since last poll to count a device online
const DUP_WINDOW = 30;             // seconds: repeat scans are ignored

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'lumina.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  shift_start TEXT NOT NULL DEFAULT '09:00',
  shift_end TEXT NOT NULL DEFAULT '18:00',
  finger_id INTEGER UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  api_key TEXT NOT NULL UNIQUE,
  last_seen INTEGER,
  ip TEXT,
  fw TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS punches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  device_id INTEGER,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('IN','OUT')),
  source TEXT NOT NULL DEFAULT 'device'
);
CREATE INDEX IF NOT EXISTS idx_punches_ts ON punches(ts);
CREATE INDEX IF NOT EXISTS idx_punches_emp_ts ON punches(employee_id, ts);
CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER,
  type TEXT NOT NULL CHECK (type IN ('enroll','delete')),
  employee_id INTEGER,
  finger_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

/* ---------- helpers ---------- */
const now = () => Math.floor(Date.now() / 1000);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => new HttpError(400, m);

function getSetting(k, def) {
  const r = db.prepare('SELECT v FROM settings WHERE k = ?').get(k);
  return r ? r.v : def;
}
function setSetting(k, v) {
  db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function randomPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(12)) s += chars[b % chars.length];
  return s;
}

/* first run: secret + admin account */
if (!getSetting('secret')) setSetting('secret', crypto.randomBytes(32).toString('hex'));
if (!getSetting('timezone')) setSetting('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
if (!getSetting('company')) setSetting('company', 'Lumina Automations');
if (!getSetting('grace_min')) setSetting('grace_min', '10');
if (!getSetting('weekly_off')) setSetting('weekly_off', '0');
const SECRET = getSetting('secret');

function resetAdmin(pw) {
  setSetting('admin_user', 'admin');
  setSetting('admin_hash', hashPassword(pw));
  setSetting('pwv', String(Number(getSetting('pwv', '0')) + 1));
}
if (process.argv.includes('--reset-password')) {
  const pw = randomPassword();
  resetAdmin(pw);
  console.log(`\nAdmin password reset.\n  Username: admin\n  Password: ${pw}\n`);
  process.exit(0);
}
if (!getSetting('admin_hash')) {
  const pw = process.env.ADMIN_PASSWORD || randomPassword();
  resetAdmin(pw);
  console.log(`\n=== First run: admin account created ===\n  Username: admin\n  Password: ${pw}\n  (change it in Settings after you log in)\n`);
}

/* ---------- time ---------- */
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtCache = new Map();
function parts(ts, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short'
    });
    fmtCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ts * 1000))) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, time: `${o.hour}:${o.minute}:${o.second}`, wd: WD.indexOf(o.weekday) };
}
function dayStart(dateStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d) / 1000;
  const p = parts(guess, tz);
  const [hh, mm, ss] = p.time.split(':').map(Number);
  const [py, pm, pd] = p.date.split('-').map(Number);
  const localAsUtc = Date.UTC(py, pm - 1, pd, hh, mm, ss) / 1000;
  return guess - (localAsUtc - guess);
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function tzOffset(ts, zone) {
  const p = parts(ts, zone);
  const [hh, mm, ss] = p.time.split(':').map(Number);
  const [y, m, d] = p.date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, ss) / 1000 - ts;
}
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));
const isHM = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
const toMin = (hms) => { const [h, m] = hms.split(':').map(Number); return h * 60 + m; };
const tz = () => getSetting('timezone', 'UTC');
const today = () => parts(now(), tz()).date;

/* ---------- sessions ---------- */
function signToken(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
}
function verifyToken(tok) {
  if (!tok) return null;
  const [b, mac] = tok.split('.');
  if (!b || !mac) return null;
  const exp = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  const x = Buffer.from(mac), y = Buffer.from(exp);
  if (x.length !== y.length || !crypto.timingSafeEqual(x, y)) return null;
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (p.exp < now() || String(p.pwv) !== getSetting('pwv', '0')) return null;
    return p;
  } catch { return null; }
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const loginFails = new Map();

/* ---------- employee / command logic ---------- */
function expireCommands() {
  const t = now();
  db.prepare(`UPDATE commands SET status='failed', message='Timed out. Check that the device is online.', updated_at=?
              WHERE status IN ('pending','sent','progress') AND created_at < ?`).run(t, t - COMMAND_TIMEOUT);
}
function activeCommand(empId) {
  return db.prepare(`SELECT id, type, status, message FROM commands
                     WHERE employee_id = ? AND status IN ('pending','sent','progress') ORDER BY id DESC LIMIT 1`).get(empId) || null;
}
function validateEmployee(b, partial) {
  const o = {};
  if (!partial || b.emp_code !== undefined) {
    o.emp_code = String(b.emp_code || '').trim();
    if (!o.emp_code || o.emp_code.length > 20) throw bad('Employee ID is required (up to 20 characters).');
  }
  if (!partial || b.name !== undefined) {
    o.name = String(b.name || '').trim();
    if (!o.name || o.name.length > 60) throw bad('Name is required (up to 60 characters).');
  }
  if (b.department !== undefined) o.department = String(b.department).trim().slice(0, 40);
  for (const k of ['shift_start', 'shift_end']) {
    if (b[k] !== undefined) {
      if (!isHM(b[k])) throw bad('Shift times must look like 09:00.');
      o[k] = b[k];
    }
  }
  if (b.active !== undefined) o.active = b.active ? 1 : 0;
  return o;
}
function nextFingerId() {
  const used = new Set();
  for (const r of db.prepare('SELECT finger_id FROM employees WHERE finger_id IS NOT NULL').all()) used.add(r.finger_id);
  for (const r of db.prepare(`SELECT finger_id FROM commands WHERE type='enroll' AND status IN ('pending','sent','progress')`).all()) used.add(r.finger_id);
  for (let i = 1; i <= MAX_FINGERS; i++) if (!used.has(i)) return i;
  throw new HttpError(409, 'The fingerprint sensor is full.');
}

/* ---------- attendance report ---------- */
function buildReport(from, to, empId) {
  const zone = tz();
  const grace = Number(getSetting('grace_min', '10'));
  const off = new Set(getSetting('weekly_off', '').split(',').filter((x) => x !== '').map(Number));
  const todayStr = today();
  const emps = empId
    ? db.prepare('SELECT * FROM employees WHERE id = ?').all(empId)
    : db.prepare('SELECT * FROM employees WHERE active = 1 ORDER BY name').all();
  const rows = [];
  if (!emps.length) return rows;
  const ids = emps.map((e) => e.id);
  const list = db.prepare(`SELECT employee_id, ts, type FROM punches WHERE ts >= ? AND ts < ? AND employee_id IN (${ids.map(() => '?').join(',')}) ORDER BY ts`)
    .all(dayStart(from, zone), dayStart(addDays(to, 1), zone), ...ids);
  const byKey = new Map();
  for (const p of list) {
    const d = parts(p.ts, zone);
    const k = p.employee_id + '|' + d.date;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({ ts: p.ts, type: p.type, time: d.time });
  }
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    for (const e of emps) {
      const ps = byKey.get(e.id + '|' + d) || [];
      const row = { date: d, emp_id: e.id, emp_code: e.emp_code, name: e.name, department: e.department,
        first_in: null, last_out: null, work_min: 0, late_min: 0, punches: ps.length, status: '' };
      if (ps.length) {
        let open = null, mins = 0;
        for (const p of ps) {
          if (p.type === 'IN') { if (open === null) open = p.ts; }
          else if (open !== null) { mins += Math.round((p.ts - open) / 60); open = null; }
        }
        const firstIn = ps.find((p) => p.type === 'IN');
        const lastOut = [...ps].reverse().find((p) => p.type === 'OUT');
        row.first_in = firstIn ? firstIn.time.slice(0, 5) : null;
        row.last_out = lastOut ? lastOut.time.slice(0, 5) : null;
        row.work_min = mins;
        if (firstIn) {
          const lateBy = toMin(firstIn.time) - toMin(e.shift_start);
          if (lateBy > grace) row.late_min = lateBy;
        }
        if (open !== null && d < todayStr) row.status = 'Missing out';
        else if (open !== null) row.status = row.late_min ? 'Late' : 'In';
        else row.status = row.late_min ? 'Late' : 'Present';
      } else if (d > todayStr) continue;
      else if (off.has(wd)) row.status = 'Off';
      else row.status = d === todayStr ? 'Not in yet' : 'Absent';
      rows.push(row);
    }
  }
  return rows;
}

/* ---------- router ---------- */
const routes = [];
function route(method, pattern, auth, handler) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, auth, handler });
}
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const fmtHM = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

/* --- auth --- */
route('POST', '/api/login', null, (c) => {
  const ip = c.req.socket.remoteAddress;
  const f = loginFails.get(ip);
  if (f && f.until > Date.now()) throw new HttpError(429, 'Too many attempts. Wait a minute and try again.');
  const ok = String(c.body.username || '') === getSetting('admin_user') && checkPassword(String(c.body.password || ''), getSetting('admin_hash'));
  if (!ok) {
    const n = (f ? f.n : 0) + 1;
    loginFails.set(ip, { n, until: n >= 5 ? Date.now() + 60000 : 0 });
    throw new HttpError(401, 'Wrong username or password.');
  }
  loginFails.delete(ip);
  const tok = signToken({ u: 'admin', pwv: getSetting('pwv', '0'), exp: now() + 7 * 86400 });
  c.headers['Set-Cookie'] = `lumina_session=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}`;
  return { ok: true };
});
route('POST', '/api/logout', null, (c) => {
  c.headers['Set-Cookie'] = 'lumina_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
  return { ok: true };
});
route('GET', '/api/me', null, (c) => {
  const p = verifyToken(cookies(c.req).lumina_session);
  return { logged_in: !!p, company: getSetting('company') };
});
route('POST', '/api/password', 'admin', (c) => {
  if (!checkPassword(String(c.body.current || ''), getSetting('admin_hash'))) throw bad('Current password is wrong.');
  const pw = String(c.body.next || '');
  if (pw.length < 8) throw bad('New password must be at least 8 characters.');
  resetAdmin(pw);
  const tok = signToken({ u: 'admin', pwv: getSetting('pwv', '0'), exp: now() + 7 * 86400 });
  c.headers['Set-Cookie'] = `lumina_session=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}`;
  return { ok: true };
});

/* --- settings --- */
route('GET', '/api/settings', 'admin', () => ({
  company: getSetting('company'), timezone: tz(), grace_min: Number(getSetting('grace_min')),
  weekly_off: getSetting('weekly_off', '').split(',').filter((x) => x !== '').map(Number),
  timezones: Intl.supportedValuesOf('timeZone')
}));
route('PUT', '/api/settings', 'admin', (c) => {
  const b = c.body;
  if (b.timezone !== undefined) {
    try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); } catch { throw bad('Unknown time zone.'); }
    setSetting('timezone', b.timezone);
  }
  if (b.company !== undefined) setSetting('company', String(b.company).trim().slice(0, 60) || 'Lumina Automations');
  if (b.grace_min !== undefined) {
    const g = Number(b.grace_min);
    if (!Number.isInteger(g) || g < 0 || g > 120) throw bad('Grace period must be 0 to 120 minutes.');
    setSetting('grace_min', g);
  }
  if (b.weekly_off !== undefined) {
    if (!Array.isArray(b.weekly_off) || b.weekly_off.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) throw bad('Invalid weekly off days.');
    setSetting('weekly_off', b.weekly_off.join(','));
  }
  return { ok: true };
});

/* --- dashboard --- */
route('GET', '/api/dashboard', 'admin', () => {
  expireCommands();
  const zone = tz(), t = today();
  const rows = buildReport(t, t);
  const total = db.prepare('SELECT COUNT(*) n FROM employees WHERE active = 1').get().n;
  const recent = db.prepare(`SELECT p.id, p.ts, p.type, p.source, e.name, e.emp_code, e.department
                             FROM punches p JOIN employees e ON e.id = p.employee_id ORDER BY p.ts DESC, p.id DESC LIMIT 40`).all()
    .map((p) => ({ ...p, ...parts(p.ts, zone) }));
  return {
    company: getSetting('company'), timezone: zone, now: now(), today: t, total,
    in_now: rows.filter((r) => r.status === 'In' || (r.status === 'Late' && r.punches % 2 === 1)).length,
    present: rows.filter((r) => ['Present', 'Late', 'In'].includes(r.status)).length,
    late: rows.filter((r) => r.late_min > 0).length,
    not_in: rows.filter((r) => r.status === 'Not in yet').length,
    recent, devices: listDevices()
  };
});

/* --- employees --- */
route('GET', '/api/employees', 'admin', () => {
  expireCommands();
  return db.prepare('SELECT * FROM employees ORDER BY active DESC, name').all()
    .map((e) => ({ ...e, enrolled: e.finger_id !== null, command: activeCommand(e.id) }));
});
route('POST', '/api/employees', 'admin', (c) => {
  const o = validateEmployee(c.body, false);
  try {
    const r = db.prepare('INSERT INTO employees (emp_code, name, department, shift_start, shift_end, created_at) VALUES (?,?,?,?,?,?)')
      .run(o.emp_code, o.name, o.department || '', o.shift_start || '09:00', o.shift_end || '18:00', now());
    return { id: Number(r.lastInsertRowid) };
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'That employee ID is already in use.');
    throw e;
  }
});
route('PUT', '/api/employees/:id', 'admin', (c) => {
  const o = validateEmployee(c.body, true);
  const keys = Object.keys(o);
  if (!keys.length) return { ok: true };
  try {
    const r = db.prepare(`UPDATE employees SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map((k) => o[k]), c.params.id);
    if (!r.changes) throw new HttpError(404, 'Employee not found.');
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'That employee ID is already in use.');
    throw e;
  }
  return { ok: true };
});
route('DELETE', '/api/employees/:id', 'admin', (c) => tx(() => {
  const e = db.prepare('SELECT * FROM employees WHERE id = ?').get(c.params.id);
  if (!e) throw new HttpError(404, 'Employee not found.');
  db.prepare(`UPDATE commands SET status='failed', message='Employee deleted', updated_at=? WHERE employee_id = ? AND status IN ('pending','sent','progress')`).run(now(), e.id);
  if (e.finger_id !== null) {
    db.prepare(`INSERT INTO commands (device_id, type, employee_id, finger_id, created_at, updated_at) VALUES (NULL,'delete',NULL,?,?,?)`).run(e.finger_id, now(), now());
  }
  db.prepare('DELETE FROM employees WHERE id = ?').run(e.id);
  return { ok: true };
}));
route('POST', '/api/employees/:id/enroll', 'admin', (c) => tx(() => {
  const e = db.prepare('SELECT * FROM employees WHERE id = ?').get(c.params.id);
  if (!e) throw new HttpError(404, 'Employee not found.');
  const deviceId = c.body.device_id ? Number(c.body.device_id) : null;
  if (!db.prepare('SELECT 1 FROM devices LIMIT 1').get()) throw new HttpError(409, 'Add a device first (Devices page).');
  db.prepare(`UPDATE commands SET status='failed', message='Replaced by a new request', updated_at=? WHERE employee_id = ? AND type='enroll' AND status IN ('pending','sent','progress')`).run(now(), e.id);
  const fid = e.finger_id !== null ? e.finger_id : nextFingerId();
  const r = db.prepare(`INSERT INTO commands (device_id, type, employee_id, finger_id, message, created_at, updated_at) VALUES (?,'enroll',?,?,?,?,?)`)
    .run(deviceId, e.id, fid, 'Waiting for the device', now(), now());
  return { command_id: Number(r.lastInsertRowid) };
}));
route('POST', '/api/employees/:id/unenroll', 'admin', (c) => tx(() => {
  const e = db.prepare('SELECT * FROM employees WHERE id = ?').get(c.params.id);
  if (!e) throw new HttpError(404, 'Employee not found.');
  if (e.finger_id === null) throw bad('This employee has no fingerprint.');
  const r = db.prepare(`INSERT INTO commands (device_id, type, employee_id, finger_id, message, created_at, updated_at) VALUES (NULL,'delete',?,?,?,?,?)`)
    .run(e.id, e.finger_id, 'Waiting for the device', now(), now());
  return { command_id: Number(r.lastInsertRowid) };
}));
route('GET', '/api/commands/:id', 'admin', (c) => {
  expireCommands();
  const r = db.prepare('SELECT id, type, status, message, finger_id FROM commands WHERE id = ?').get(c.params.id);
  if (!r) throw new HttpError(404, 'Not found.');
  return r;
});
route('POST', '/api/commands/:id/cancel', 'admin', (c) => {
  db.prepare(`UPDATE commands SET status='failed', message='Cancelled', updated_at=? WHERE id = ? AND status IN ('pending','sent','progress')`).run(now(), c.params.id);
  return { ok: true };
});

/* --- punches --- */
route('GET', '/api/punches', 'admin', (c) => {
  const zone = tz(), t = today();
  const from = isDate(c.query.from) ? c.query.from : t;
  const to = isDate(c.query.to) ? c.query.to : t;
  if (from > to) throw bad('"From" must be on or before "To".');
  const args = [dayStart(from, zone), dayStart(addDays(to, 1), zone)];
  let sql = `SELECT p.id, p.ts, p.type, p.source, e.id emp_id, e.name, e.emp_code FROM punches p JOIN employees e ON e.id = p.employee_id WHERE p.ts >= ? AND p.ts < ?`;
  if (c.query.employee_id) { sql += ' AND p.employee_id = ?'; args.push(Number(c.query.employee_id)); }
  sql += ' ORDER BY p.ts DESC LIMIT 2000';
  return db.prepare(sql).all(...args).map((p) => ({ ...p, ...parts(p.ts, zone) }));
});
route('POST', '/api/punches', 'admin', (c) => {
  const b = c.body;
  if (!isDate(b.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time || '')) throw bad('Enter a valid date and time.');
  if (!['IN', 'OUT'].includes(b.type)) throw bad('Type must be IN or OUT.');
  if (!db.prepare('SELECT 1 FROM employees WHERE id = ?').get(b.employee_id)) throw new HttpError(404, 'Employee not found.');
  const ts = dayStart(b.date, tz()) + toMin(b.time) * 60;
  db.prepare(`INSERT INTO punches (employee_id, ts, type, source) VALUES (?,?,?,'manual')`).run(b.employee_id, ts, b.type);
  return { ok: true };
});
route('DELETE', '/api/punches/:id', 'admin', (c) => {
  db.prepare('DELETE FROM punches WHERE id = ?').run(c.params.id);
  return { ok: true };
});

/* --- reports --- */
function reportRange(q) {
  const t = today();
  const from = isDate(q.from) ? q.from : addDays(t, -6);
  const to = isDate(q.to) ? q.to : t;
  if (from > to) throw bad('"From" must be on or before "To".');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 92) throw bad('Choose a range of 93 days or less.');
  return { from, to, empId: q.employee_id ? Number(q.employee_id) : null };
}
route('GET', '/api/report', 'admin', (c) => {
  const { from, to, empId } = reportRange(c.query);
  return { from, to, rows: buildReport(from, to, empId) };
});
route('GET', '/api/report.csv', 'admin', (c) => {
  const { from, to, empId } = reportRange(c.query);
  const head = ['Date', 'Employee ID', 'Name', 'Department', 'First in', 'Last out', 'Hours worked', 'Late (min)', 'Punches', 'Status'];
  const lines = [head.join(',')];
  for (const r of buildReport(from, to, empId)) {
    lines.push([r.date, r.emp_code, r.name, r.department, r.first_in, r.last_out, fmtHM(r.work_min), r.late_min || '', r.punches, r.status].map(csvCell).join(','));
  }
  c.raw = { type: 'text/csv; charset=utf-8', body: '\ufeff' + lines.join('\r\n'), name: `attendance_${from}_to_${to}.csv` };
});

/* --- devices (admin) --- */
function listDevices() {
  const t = now();
  return db.prepare('SELECT id, name, api_key, last_seen, ip, fw FROM devices ORDER BY id').all()
    .map((d) => ({ ...d, online: d.last_seen !== null && t - d.last_seen <= ONLINE_WINDOW }));
}
route('GET', '/api/devices', 'admin', () => listDevices());
route('POST', '/api/devices', 'admin', (c) => {
  const name = String(c.body.name || '').trim().slice(0, 40);
  if (!name) throw bad('Give the device a name.');
  const key = 'lum_' + crypto.randomBytes(16).toString('hex');
  const r = db.prepare('INSERT INTO devices (name, api_key, created_at) VALUES (?,?,?)').run(name, key, now());
  return { id: Number(r.lastInsertRowid), api_key: key };
});
route('POST', '/api/devices/:id/clear-fingerprints', 'admin', (c) => {
  // A "delete" command with finger_id 0 means: erase every fingerprint on the sensor.
  const d = db.prepare('SELECT id FROM devices WHERE id = ?').get(c.params.id);
  if (!d) throw new HttpError(404, 'Device not found.');
  db.prepare(`UPDATE commands SET status='failed', message='Replaced by a new request', updated_at=? WHERE device_id = ? AND status IN ('pending','sent','progress')`).run(now(), d.id);
  const r = db.prepare(`INSERT INTO commands (device_id, type, employee_id, finger_id, message, created_at, updated_at) VALUES (?,'delete',NULL,0,?,?,?)`)
    .run(d.id, 'Waiting for the device', now(), now());
  return { command_id: Number(r.lastInsertRowid) };
});
route('DELETE', '/api/devices/:id', 'admin', (c) => {
  db.prepare('DELETE FROM devices WHERE id = ?').run(c.params.id);
  return { ok: true };
});

/* --- device protocol --- */
route('POST', '/api/device/poll', 'device', (c) => {
  expireCommands();
  const d = c.device;
  if (c.body.fw) db.prepare('UPDATE devices SET fw = ? WHERE id = ?').run(String(c.body.fw).slice(0, 20), d.id);
  const cmd = db.prepare(`SELECT * FROM commands WHERE status='pending' AND (device_id IS NULL OR device_id = ?) ORDER BY id LIMIT 1`).get(d.id);
  let command = null;
  if (cmd) {
    db.prepare(`UPDATE commands SET status='sent', device_id=?, message='Device is working on it', updated_at=? WHERE id = ?`).run(d.id, now(), cmd.id);
    const emp = cmd.employee_id ? db.prepare('SELECT name FROM employees WHERE id = ?').get(cmd.employee_id) : null;
    command = { id: cmd.id, type: cmd.type, finger_id: cmd.finger_id, name: emp ? emp.name : '' };
  }
  return { ok: true, now: now(), tz_offset: tzOffset(now(), tz()), command };
});
route('POST', '/api/device/result', 'device', (c) => tx(() => {
  const id = Number(c.body.id);
  const status = c.body.status;
  if (!['progress', 'done', 'failed'].includes(status)) throw bad('Bad status.');
  const cmd = db.prepare(`SELECT * FROM commands WHERE id = ? AND status IN ('sent','progress') AND device_id = ?`).get(id, c.device.id);
  if (!cmd) return { ok: false, ignored: true };
  const msg = String(c.body.message || '').slice(0, 120);
  db.prepare('UPDATE commands SET status = ?, message = ?, updated_at = ? WHERE id = ?').run(status, msg, now(), id);
  if (status === 'done' && cmd.type === 'delete' && cmd.finger_id === 0) {
    db.prepare('UPDATE employees SET finger_id = NULL').run();   // sensor was wiped
  }
  if (status === 'done' && cmd.employee_id) {
    if (cmd.type === 'enroll') {
      db.prepare('UPDATE employees SET finger_id = NULL WHERE finger_id = ? AND id != ?').run(cmd.finger_id, cmd.employee_id);
      db.prepare('UPDATE employees SET finger_id = ? WHERE id = ?').run(cmd.finger_id, cmd.employee_id);
    } else {
      db.prepare('UPDATE employees SET finger_id = NULL WHERE id = ? AND finger_id = ?').run(cmd.employee_id, cmd.finger_id);
    }
  }
  return { ok: true };
}));
route('POST', '/api/device/punch', 'device', (c) => tx(() => {
  const fid = Number(c.body.finger_id);
  const e = db.prepare('SELECT * FROM employees WHERE finger_id = ?').get(fid);
  if (!e) return { ok: false, error: 'unknown' };
  if (!e.active) return { ok: false, error: 'inactive', name: e.name };
  const t = now();
  let ts = Number(c.body.ts);
  if (!(ts > 1600000000 && ts <= t + 300)) ts = t;
  const zone = tz();
  const day = parts(ts, zone).date;
  const last = db.prepare('SELECT ts, type FROM punches WHERE employee_id = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT 1')
    .get(e.id, dayStart(day, zone), ts);
  if (last && ts - last.ts < DUP_WINDOW) {
    return { ok: true, duplicate: true, name: e.name, type: last.type, time: parts(last.ts, zone).time.slice(0, 5) };
  }
  const type = last && last.type === 'IN' ? 'OUT' : 'IN';
  db.prepare(`INSERT INTO punches (employee_id, device_id, ts, type, source) VALUES (?,?,?,?,'device')`).run(e.id, c.device.id, ts, type);
  return { ok: true, name: e.name, type, time: parts(ts, zone).time.slice(0, 5) };
}));

/* ---------- server ---------- */
const INDEX = path.join(__dirname, 'public', 'index.html');
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"
};
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (ch) => {
      size += ch.length;
      if (size > 100000) { reject(new HttpError(413, 'Request too large.')); req.destroy(); return; }
      chunks.push(ch);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(bad('Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}
function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS, ...headers });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SEC_HEADERS });
      return res.end(fs.readFileSync(INDEX));
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.rx.exec(url.pathname);
      if (!m) continue;
      const ctx = { req, params: {}, query: Object.fromEntries(url.searchParams), body: {}, headers: {}, raw: null };
      r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
      if (r.auth === 'admin') {
        if (!verifyToken(cookies(req).lumina_session)) throw new HttpError(401, 'Please log in.');
      } else if (r.auth === 'device') {
        const key = req.headers['x-device-key'];
        const d = key && db.prepare('SELECT * FROM devices WHERE api_key = ?').get(String(key));
        if (!d) throw new HttpError(401, 'Unknown device key.');
        db.prepare('UPDATE devices SET last_seen = ?, ip = ? WHERE id = ?').run(now(), String(req.socket.remoteAddress).replace('::ffff:', ''), d.id);
        ctx.device = d;
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        if (!/application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Send JSON.');
        ctx.body = await readBody(req);
      }
      const out = r.handler(ctx);
      if (ctx.raw) {
        res.writeHead(200, { 'Content-Type': ctx.raw.type, 'Content-Disposition': `attachment; filename="${ctx.raw.name}"`, ...SEC_HEADERS });
        return res.end(ctx.raw.body);
      }
      return sendJson(res, 200, out, ctx.headers);
    }
    throw new HttpError(404, 'Not found.');
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'Something went wrong on the server.' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Lumina Attendance running on http://localhost:${PORT}  (time zone: ${tz()})`);
});