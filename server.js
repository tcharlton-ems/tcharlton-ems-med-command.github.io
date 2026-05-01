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
 *   PUT    /api/settings           Update settings (password, about, etc.)
 *   GET    /api/about              Retrieve about content (public)
 *   POST   /api/refresh            Trigger a refresh (updates lastRefresh timestamp)
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app      = express();
const PORT     = process.env.PORT || 3000;
const DATA_FILE = '/app/data/data.json';
const HTML_FILE = path.join(__dirname, 'index.html');

// ── Simple in-memory token store (token → expiry ms) ──
const tokens = new Map();
const TOKEN_TTL = 4 * 60 * 60 * 1000; // 4 hours

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─────────────────────────────────────────────────
// DATA HELPERS
// ─────────────────────────────────────────────────
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return getDefaultData();
  }
}

function saveData(data) {
  data.lastSaved = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
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
    protocols: [],
    about: `# About These Protocols

## Agency Information

**Agency Name:** Your EMS Agency Name  
**Service Area:** Your Service Area  
**Agency Type:** ALS / BLS Transport

---

## Medical Direction

**Medical Director:** Medical Director Name, MD  
**Contact:** medical.director@example.com

---

## Protocol Information

**Protocol Version:** 2025.1  
**Effective Date:** January 1, 2025  
**Review Cycle:** Annual

These protocols are intended for use by licensed EMS personnel operating under the medical direction of the agency medical director. All personnel are expected to be familiar with and adhere to these protocols.

---

## Licensing & Scope

All providers must maintain current licensure with the state EMS regulatory authority and operate within their defined scope of practice. These protocols do not supersede state or local regulations.

---

## Disclaimer

These protocols are for use by trained EMS professionals only. Clinical judgment should always be applied in conjunction with these guidelines.`
  };
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + 'medcmd_salt').digest('hex');
}

function genToken() {
  const t = crypto.randomBytes(32).toString('hex');
  tokens.set(t, Date.now() + TOKEN_TTL);
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

const ADMIN_FILE = path.join(__dirname, 'admin.html');

// ─────────────────────────────────────────────────
// STATIC FILES
// ─────────────────────────────────────────────────
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
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  const data = loadData();
  const hash = hashPassword(password || '');
  if (hash !== data.adminPasswordHash) {
    return res.status(401).json({ error: 'Invalid password' });
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
  const { adminPasswordHash, ...incoming } = req.body; // guard — never allow overwriting hash via this route
  Object.assign(data, incoming);
  saveData(data);
  res.json({ ok: true, lastSaved: data.lastSaved });
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
  const p = { ...req.body, id: req.body.id || newId('p') };
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
  data.protocols[idx] = { ...data.protocols[idx], ...req.body, id: req.params.id };
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
// PROTOCOL SETS
// ─────────────────────────────────────────────────
app.get('/api/sets', (req, res) => res.json(loadData().sets || []));

app.post('/api/sets', requireAuth, (req, res) => {
  const data = loadData();
  const s = { ...req.body, id: req.body.id || newId('set') };
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
  const t = { ...req.body };
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
  const l = { ...req.body };
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
// ABOUT  (read = public, write = admin via settings)
// ─────────────────────────────────────────────────
app.get('/api/about', (req, res) => {
  const data = loadData();
  res.json({ about: data.about || '' });
});

// ─────────────────────────────────────────────────
// SETTINGS (password change, about content)
// ─────────────────────────────────────────────────
app.put('/api/settings', requireAuth, (req, res) => {
  const data = loadData();
  if (req.body.newPassword) {
    data.adminPasswordHash = hashPassword(req.body.newPassword);
  }
  if (typeof req.body.about === 'string') {
    data.about = req.body.about;
  }
  saveData(data);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────

// Ensure the persistent data directory exists
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

// Initialise data.json if it doesn't exist
if (!fs.existsSync(DATA_FILE)) {
  saveData(getDefaultData());
  console.log('Created fresh data.json with default data.');
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
