/**
 * MedCommand EMS Protocol Application — Server
 * 
 * Serves the single-page app and provides a REST API backed by a JSON file.
 * All state (protocols, sets, tags, levels, settings) is persisted to data.json.
 * 
 * API Routes:
 *   GET    /api/state              Full application state
 *   PUT    /api/state              Replace full state (bulk save)
 *   GET    /api/protocols          All protocols
 *   POST   /api/protocols          Create protocol
 *   PUT    /api/protocols/:id      Update protocol
 *   DELETE /api/protocols/:id      Delete protocol
 *   GET    /api/sets               Protocol sets
 *   POST   /api/sets               Create set
 *   DELETE /api/sets/:id           Delete set
 *   GET    /api/tags               Tags
 *   POST   /api/tags               Create tag
 *   DELETE /api/tags/:id           Delete tag
 *   GET    /api/levels             Skill levels
 *   POST   /api/levels             Create level
 *   DELETE /api/levels/:id         Delete level
 *   POST   /api/auth               Verify admin password → returns token
 *   PUT    /api/settings           Update settings (password, etc.)
 *   POST   /api/refresh            Trigger a refresh (updates lastRefresh timestamp)
 */

'use strict';

const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const multer   = require('multer');
const mammoth  = require('mammoth');
const TurndownService = require('turndown');
const { gfm }  = require('turndown-plugin-gfm');

const app      = express();
const PORT     = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const HTML_FILE = path.join(__dirname, 'index.html');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 50 } });
const turndownService = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
turndownService.use(gfm);

// ── Simple in-memory token store (token → expiry ms) ──
const tokens = new Map();
const TOKEN_TTL = 4 * 60 * 60 * 1000; // 4 hours

// Both clients are served same-origin from this server, so no CORS is needed;
// enabling it would only let other websites read the protocol data.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Now that marked/DOMPurify are served locally, lock scripts, styles, and
  // network calls to same-origin. 'unsafe-inline' is still required for the
  // app's inline handlers/styles, but any injected *external* <script>/fetch
  // is blocked outright. data: images allow base64 images from imported .docx.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
  next();
});
app.use(express.json({ limit: '10mb' }));

// ─────────────────────────────────────────────────
// DATA HELPERS
// ─────────────────────────────────────────────────
const BACKUP_DIR   = path.join(__dirname, 'backups');
const MAX_BACKUPS  = 30;

// Copy the current data.json into backups/ with a label + timestamp.
// Never throws — a failed backup must not block normal operation.
function writeBackup(label) {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, `data-${label}-${stamp}.json`));
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
    while (files.length > MAX_BACKUPS) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (e) {
    console.error('Backup failed:', e.message);
  }
}

let corruptBackedUp = false; // loadData runs per-request; only snapshot a corrupt file once

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    // If the file exists but can't be parsed, preserve it before falling
    // back to defaults so protocols are never silently lost.
    if (!corruptBackedUp && fs.existsSync(DATA_FILE)) {
      writeBackup('corrupt');
      corruptBackedUp = true;
    }
    return getDefaultData();
  }
}

function saveData(data) {
  // Safety net: back up before any write that would shrink the protocol list.
  try {
    const onDisk = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const before = (onDisk.protocols || []).length;
    const after  = (data.protocols  || []).length;
    if (after < before) writeBackup('pre-delete');
  } catch (e) { /* no existing file or unreadable — nothing to protect */ }

  data.lastSaved = new Date().toISOString();
  // Atomic write: write to a temp file, then rename over data.json, so a
  // crash mid-write can never leave a truncated/corrupt data file.
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function getDefaultData() {
  return {
    lastRefresh: new Date().toISOString(),
    lastSaved: new Date().toISOString(),
    adminPasswordHash: hashPassword('admin123'),
    sets: [
      { id: 'set1', name: 'ALS Protocols 2025', url: '' },
      { id: 'set2', name: 'BLS Protocols 2025', url: '' }
    ],
    tags: [
      { id: 'medical',        name: 'Medical',        color: '#2979ff' },
      { id: 'trauma',         name: 'Trauma',         color: '#f44336' },
      { id: 'pediatric',      name: 'Pediatric',      color: '#ff9800' },
      { id: 'cardiology',     name: 'Cardiology',     color: '#e91e63' },
      { id: 'respiratory',    name: 'Respiratory',    color: '#00bcd4' },
      { id: 'obstetrics',     name: 'Obstetrics',     color: '#9c27b0' },
      { id: 'procedure',      name: 'Procedure',      color: '#607d8b' },
      { id: 'administrative', name: 'Administrative', color: '#795548' },
      { id: 'appendix',       name: 'Appendix',       color: '#9e9e9e' }
    ],
    levels: [
      { id: 'emt',       name: 'EMT',       color: '#2979ff' },
      { id: 'aemt',      name: 'AEMT',      color: '#00bcd4' },
      { id: 'paramedic', name: 'Paramedic', color: '#9c27b0' }
    ],
    protocols: []
  };
}

// Passwords are hashed with scrypt (memory-hard, brute-force resistant) and a
// per-password random salt, stored as "scrypt$<salt>$<hash>". Hashes written by
// older versions (bare SHA-256 + fixed salt) are still verified and get
// upgraded to scrypt on the next successful login.
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function legacyHash(pw) {
  return crypto.createHash('sha256').update(pw + 'medcmd_salt').digest('hex');
}

function timingSafeHexEqual(aHex, bHex) {
  const a = Buffer.from(String(aHex), 'hex');
  const b = Buffer.from(String(bHex), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyPassword(pw, stored) {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith('scrypt$')) {
    const [, salt, hash] = stored.split('$');
    if (!salt || !hash) return false;
    const candidate = crypto.scryptSync(String(pw), salt, 64).toString('hex');
    return timingSafeHexEqual(candidate, hash);
  }
  return timingSafeHexEqual(legacyHash(String(pw)), stored);
}

// ── Brute-force protection for /api/auth (per-IP, in-memory) ──
const authAttempts = new Map(); // ip → { fails, resetAt }
const AUTH_MAX_FAILS = 10;
const AUTH_WINDOW_MS = 15 * 60 * 1000;

function authLimiter(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const entry = authAttempts.get(ip);
  if (entry && Date.now() > entry.resetAt) authAttempts.delete(ip);
  const current = authAttempts.get(ip);
  if (current && current.fails >= AUTH_MAX_FAILS) {
    const mins = Math.ceil((current.resetAt - Date.now()) / 60000);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} minute(s).` });
  }
  next();
}

function recordAuthFail(req) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const entry = authAttempts.get(ip) || { fails: 0, resetAt: Date.now() + AUTH_WINDOW_MS };
  entry.fails++;
  authAttempts.set(ip, entry);
}

function clearAuthFails(req) {
  authAttempts.delete(req.ip || req.socket.remoteAddress || 'unknown');
}

function genToken() {
  // Sweep expired tokens so the map can't grow unbounded across a long uptime
  const now = Date.now();
  for (const [t, exp] of tokens) if (now > exp) tokens.delete(t);
  const t = crypto.randomBytes(32).toString('hex');
  tokens.set(t, now + TOKEN_TTL);
  return t;
}

function validToken(req) {
  const auth = req.headers['authorization'] || '';
  const t = auth.replace('Bearer ', '').trim();
  if (!t) return false;
  const exp = tokens.get(t);
  if (!exp || Date.now() > exp) { tokens.delete(t); return false; }
  return true;
}

function requireAuth(req, res, next) {
  if (!validToken(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function newId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

// ─────────────────────────────────────────────────
// INPUT VALIDATION — every write route builds its object through these
// helpers instead of spreading req.body, so unknown fields, wrong types,
// and oversized values never reach data.json. Ids are restricted to a safe
// charset because the clients interpolate them into inline event handlers.
// ─────────────────────────────────────────────────
const ID_RE    = /^[A-Za-z0-9_-]{1,100}$/;
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

function cleanStr(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}

function cleanId(v) {
  return (typeof v === 'string' && ID_RE.test(v)) ? v : undefined;
}

// partial=true (updates) only includes fields present in the input;
// partial=false (creates/imports) requires a non-empty title.
function sanitizeProtocol(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object') return null;
  const out = {};
  const id      = cleanId(body.id);
  const title   = cleanStr(body.title, 300);
  const setId   = cleanStr(body.setId, 100);
  const level   = cleanStr(body.level, 100);
  const revised = cleanStr(body.revised, 30);
  const content = cleanStr(body.content, 500000);
  if (id      !== undefined) out.id      = id;
  if (title   !== undefined) out.title   = title;
  if (setId   !== undefined) out.setId   = setId;
  if (level   !== undefined) out.level   = level;
  if (revised !== undefined) out.revised = revised;
  if (content !== undefined) out.content = content;
  if (Array.isArray(body.tags)) {
    out.tags = body.tags.filter(t => typeof t === 'string').slice(0, 50).map(t => t.slice(0, 50));
  }
  if (!partial) {
    if (!out.title || !out.title.trim()) return null;
    if (!out.tags) out.tags = [];
    if (out.content === undefined) out.content = '';
  }
  return out;
}

// Shared shape for sets, tags, and skill levels: { id, name, color?, url? }
function sanitizeNamed(body, idPrefix) {
  if (!body || typeof body !== 'object') return null;
  const name = (cleanStr(body.name, 100) || '').trim();
  if (!name) return null;
  const out = { id: cleanId(body.id) || newId(idPrefix), name };
  if (typeof body.color === 'string' && COLOR_RE.test(body.color)) out.color = body.color;
  if (typeof body.url === 'string') out.url = body.url.slice(0, 500);
  return out;
}

// ─────────────────────────────────────────────────
// FILE IMPORT HELPERS (Word / Markdown → protocol format)
// ─────────────────────────────────────────────────

// Optional leading `---\n key: value \n---` block for per-file metadata overrides.
function parseFrontMatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) meta[kv[1].trim().toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

function extractTitle(md) {
  const m = md.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m);
  return m ? m[1].trim() : '';
}

function titleFromFilename(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

const ADMIN_FILE = path.join(__dirname, 'admin.html');

// ─────────────────────────────────────────────────
// STATIC FILES
// ─────────────────────────────────────────────────
// Locally-hosted third-party libraries (marked, DOMPurify). Bundled so the
// app is fully self-contained with no CDN dependency. express.static resolves
// only within this folder and blocks path traversal.
app.use('/vendor', express.static(path.join(__dirname, 'vendor'), {
  maxAge: '30d',
  immutable: true
}));

app.get('/', (req, res) => {
  if (fs.existsSync(HTML_FILE)) {
    res.sendFile(HTML_FILE);
  } else {
    res.status(404).send('index.html not found. Please place the MedCommand HTML file as index.html in the same directory as server.js.');
  }
});

app.get('/admin', (req, res) => {
  if (fs.existsSync(ADMIN_FILE)) {
    res.sendFile(ADMIN_FILE);
  } else {
    res.status(404).send('admin.html not found.');
  }
});

// ─────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────
app.post('/api/auth', authLimiter, (req, res) => {
  const { password } = req.body || {};
  const data = loadData();
  if (!verifyPassword(password || '', data.adminPasswordHash)) {
    recordAuthFail(req);
    return res.status(401).json({ error: 'Invalid password' });
  }
  clearAuthFails(req);
  // Transparently upgrade legacy SHA-256 hashes to scrypt
  if (!String(data.adminPasswordHash).startsWith('scrypt$')) {
    data.adminPasswordHash = hashPassword(password);
    saveData(data);
  }
  res.json({ token: genToken() });
});

// ─────────────────────────────────────────────────
// FULL STATE  (read = public, write = admin)
// ─────────────────────────────────────────────────
app.get('/api/state', (req, res) => {
  const data = loadData();
  // Never expose password hash to client
  const { adminPasswordHash, ...safe } = data;
  res.json(safe);
});

app.put('/api/state', requireAuth, (req, res) => {
  const data = loadData();
  const body = req.body || {};
  // Whitelist: only these keys can be bulk-saved, each validated item-by-item.
  // The password hash is never writable through this route.
  if (Array.isArray(body.sets))   data.sets   = body.sets.map(s => sanitizeNamed(s, 'set')).filter(Boolean);
  if (Array.isArray(body.tags))   data.tags   = body.tags.map(t => sanitizeNamed(t, 'tag')).filter(Boolean);
  if (Array.isArray(body.levels)) data.levels = body.levels.map(l => sanitizeNamed(l, 'lvl')).filter(Boolean);
  if (typeof body.lastRefresh === 'string') data.lastRefresh = body.lastRefresh.slice(0, 40);
  // Guard — a bulk save may never silently wipe existing protocols. Deleting
  // protocols must go through DELETE /api/protocols/:id.
  if (Array.isArray(body.protocols) && (body.protocols.length || !(data.protocols || []).length)) {
    data.protocols = body.protocols.map(p => sanitizeProtocol(p)).filter(Boolean);
  }
  saveData(data);
  res.json({ ok: true, lastSaved: data.lastSaved });
});

// ─────────────────────────────────────────────────
// BACKUP — download a snapshot of all protocols & config.
// The file is directly re-importable via the admin Import modal
// (its "protocols" array) and excludes the password hash.
// ─────────────────────────────────────────────────
app.get('/api/backup/download', (req, res) => {
  const { adminPasswordHash, ...safe } = loadData();
  const stamp = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="medcommand-backup-${stamp}.json"`);
  res.send(JSON.stringify(safe, null, 2));
});

// Restore from an uploaded backup file. Replaces sets/tags/levels/protocols
// with the backup's contents. The current data is snapshotted to backups/
// first, and the admin password is never touched by a restore.
app.post('/api/backup/restore', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No backup file uploaded' });

  let backup;
  try {
    backup = JSON.parse(req.file.buffer.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'File is not valid JSON' });
  }
  if (!backup || typeof backup !== 'object' || !Array.isArray(backup.protocols)) {
    return res.status(400).json({ error: 'Not a MedCommand backup — missing "protocols" array' });
  }
  for (const key of ['sets', 'tags', 'levels']) {
    if (backup[key] !== undefined && !Array.isArray(backup[key])) {
      return res.status(400).json({ error: `Invalid backup — "${key}" must be an array` });
    }
  }

  writeBackup('pre-restore');

  const data = loadData();
  // Run every restored item through the same validation as normal creates,
  // so a hand-edited backup can't smuggle in malformed records.
  data.protocols = backup.protocols.map(p => sanitizeProtocol(p)).filter(Boolean);
  if (backup.sets   && backup.sets.length)   data.sets   = backup.sets.map(s => sanitizeNamed(s, 'set')).filter(Boolean);
  if (backup.tags)   data.tags   = backup.tags.map(t => sanitizeNamed(t, 'tag')).filter(Boolean);
  if (backup.levels && backup.levels.length) data.levels = backup.levels.map(l => sanitizeNamed(l, 'lvl')).filter(Boolean);
  saveData(data);

  res.json({
    ok: true,
    protocols: data.protocols.length,
    sets: data.sets.length,
    tags: data.tags.length,
    levels: data.levels.length
  });
});

// ─────────────────────────────────────────────────
// REFRESH
// ─────────────────────────────────────────────────
app.post('/api/refresh', (req, res) => {
  const data = loadData();
  data.lastRefresh = new Date().toISOString();
  saveData(data);
  res.json({ lastRefresh: data.lastRefresh });
});

// ─────────────────────────────────────────────────
// PROTOCOLS
// ─────────────────────────────────────────────────
app.get('/api/protocols', (req, res) => {
  const data = loadData();
  res.json(data.protocols || []);
});

app.post('/api/protocols', requireAuth, (req, res) => {
  const data = loadData();
  const p = sanitizeProtocol(req.body);
  if (!p) return res.status(400).json({ error: 'Invalid protocol — a non-empty title is required' });
  if (!p.id) p.id = newId('p');
  data.protocols = data.protocols || [];
  // Prevent duplicate IDs
  if (data.protocols.find(x => x.id === p.id)) p.id = newId('p');
  data.protocols.push(p);
  saveData(data);
  res.status(201).json(p);
});

app.put('/api/protocols/:id', requireAuth, (req, res) => {
  const data = loadData();
  const idx = (data.protocols || []).findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Protocol not found' });
  const updates = sanitizeProtocol(req.body, { partial: true }) || {};
  data.protocols[idx] = { ...data.protocols[idx], ...updates, id: req.params.id };
  saveData(data);
  res.json(data.protocols[idx]);
});

app.delete('/api/protocols/:id', requireAuth, (req, res) => {
  const data = loadData();
  const before = (data.protocols || []).length;
  data.protocols = (data.protocols || []).filter(p => p.id !== req.params.id);
  if (data.protocols.length === before) return res.status(404).json({ error: 'Not found' });
  saveData(data);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────
// IMPORT — convert uploaded Word (.docx) / Markdown (.md, .markdown, .txt)
// files into protocol objects. Does not save; the client reviews the
// result and submits it through the normal /api/protocols create flow.
// ─────────────────────────────────────────────────
app.post('/api/import/convert', requireAuth, upload.array('files', 50), async (req, res) => {
  const data = loadData();
  const defaultSetId = (data.sets[0] || {}).id || '';
  const defaultLevel = (data.levels[0] || {}).id || '';
  const protocols = [];
  const errors = [];

  for (const file of req.files || []) {
    const ext = path.extname(file.originalname).toLowerCase();
    try {
      let rawText;
      if (ext === '.docx') {
        const result = await mammoth.convertToHtml({ buffer: file.buffer });
        rawText = turndownService.turndown(result.value);
      } else if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
        rawText = file.buffer.toString('utf8');
      } else {
        errors.push({ file: file.originalname, error: 'Unsupported file type (use .docx, .md, .markdown, or .txt)' });
        continue;
      }

      const { meta, body } = parseFrontMatter(rawText);
      const content = body.trim();
      const title = meta.title || extractTitle(content) || titleFromFilename(file.originalname);
      const tags = meta.tags ? meta.tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : [];
      const level = (meta.level || defaultLevel || '').toLowerCase();
      const setId = meta.set || meta.setid || defaultSetId;
      const revised = meta.revised || new Date().toISOString().split('T')[0];

      protocols.push({ title, setId, level, tags, revised, content });
    } catch (e) {
      errors.push({ file: file.originalname, error: e.message });
    }
  }

  res.json({ protocols, errors });
});

// ─────────────────────────────────────────────────
// PROTOCOL SETS
// ─────────────────────────────────────────────────
app.get('/api/sets', (req, res) => res.json(loadData().sets || []));

app.post('/api/sets', requireAuth, (req, res) => {
  const data = loadData();
  const s = sanitizeNamed(req.body, 'set');
  if (!s) return res.status(400).json({ error: 'Invalid set — a non-empty name is required' });
  data.sets = data.sets || [];
  data.sets.push(s);
  saveData(data);
  res.status(201).json(s);
});

app.delete('/api/sets/:id', requireAuth, (req, res) => {
  const data = loadData();
  if ((data.sets || []).length <= 1) return res.status(400).json({ error: 'Cannot remove last set' });
  data.sets = (data.sets || []).filter(s => s.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────
// TAGS
// ─────────────────────────────────────────────────
app.get('/api/tags', (req, res) => res.json(loadData().tags || []));

app.post('/api/tags', requireAuth, (req, res) => {
  const data = loadData();
  const t = sanitizeNamed(req.body, 'tag');
  if (!t) return res.status(400).json({ error: 'Invalid tag — a non-empty name is required' });
  data.tags = data.tags || [];
  data.tags.push(t);
  saveData(data);
  res.status(201).json(t);
});

app.delete('/api/tags/:id', requireAuth, (req, res) => {
  const data = loadData();
  data.tags = (data.tags || []).filter(t => t.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────
// SKILL LEVELS
// ─────────────────────────────────────────────────
app.get('/api/levels', (req, res) => res.json(loadData().levels || []));

app.post('/api/levels', requireAuth, (req, res) => {
  const data = loadData();
  const l = sanitizeNamed(req.body, 'lvl');
  if (!l) return res.status(400).json({ error: 'Invalid level — a non-empty name is required' });
  data.levels = data.levels || [];
  data.levels.push(l);
  saveData(data);
  res.status(201).json(l);
});

app.delete('/api/levels/:id', requireAuth, (req, res) => {
  const data = loadData();
  data.levels = (data.levels || []).filter(l => l.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────
// SETTINGS (password change)
// ─────────────────────────────────────────────────
app.put('/api/settings', requireAuth, (req, res) => {
  const data = loadData();
  const pw = (req.body || {}).newPassword;
  if (pw !== undefined) {
    if (typeof pw !== 'string' || pw.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    data.adminPasswordHash = hashPassword(pw);
  }
  saveData(data);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────
// ERROR HANDLER (e.g. multer upload failures)
// ─────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (!err) return next();
  res.status(400).json({ error: err.message || 'Request failed' });
});

// ─────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────

// Initialise data.json if it doesn't exist
if (!fs.existsSync(DATA_FILE)) {
  saveData(getDefaultData());
  console.log('Created fresh data.json with default data.');
} else {
  // Snapshot existing data on every startup so a code update or bad deploy
  // can never take the protocols with it.
  writeBackup('startup');
}

app.listen(PORT, () => {
  console.log(`\n  ✚ MedCommand EMS Protocol Server`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  Running at:  http://localhost:${PORT}`);
  console.log(`  Data file:   ${DATA_FILE}`);
  console.log(`  HTML file:   ${HTML_FILE}`);
  console.log(`\n  Default admin password: admin123`);
  console.log(`  Change it immediately in the Admin Panel.\n`);
});
