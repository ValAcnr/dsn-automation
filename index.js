'use strict';

const express       = require('express');
const path          = require('path');
const fs            = require('fs');
const archiver      = require('archiver');
const { handleFeuille }            = require('./modules/webhook');
const { readWorkbook, getSheetData } = require('./modules/excel');
const parserFacture = require('./modules/parser-facture');
const parserMapping = require('./modules/parser-mapping');
const logger        = require('./modules/logger');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/pdfs', express.static(path.join(__dirname, 'pdfs')));

// Allow fetch from file:// (Origin: null) and any local origin
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Routes ───────────────────────────────────────────────────────────────────

const PINS_PATH = path.join(__dirname, 'config', 'pins.json');
const loginAttempts = new Map(); // ip -> { count, blockedUntil }
const MAX_LOGIN_ATTEMPTS = 5;
const BLOCK_MS = 15 * 60 * 1000; // 15 min

app.post('/api/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  const entry = loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };
  if (entry.blockedUntil > now) {
    return res.status(429).json({ success: false, blocked: true });
  }

  const nom  = String(req.body.nom  || '').trim().toUpperCase();
  const code = String(req.body.code || '').trim();
  if (!nom || !code) return res.status(400).json({ success: false });

  let pins;
  try {
    pins = JSON.parse(fs.readFileSync(PINS_PATH, 'utf8'));
  } catch (err) {
    logger.err(`Login : impossible de lire pins.json — ${err.message}`);
    return res.status(500).json({ success: false });
  }

  if (pins[nom] !== undefined && pins[nom] === code) {
    loginAttempts.delete(ip);
    return res.json({ success: true, nom });
  }

  entry.count += 1;
  if (entry.count >= MAX_LOGIN_ATTEMPTS) {
    entry.blockedUntil = now + BLOCK_MS;
    loginAttempts.set(ip, entry);
    return res.json({ success: false, blocked: true });
  }
  loginAttempts.set(ip, entry);
  res.json({ success: false, blocked: false, restants: MAX_LOGIN_ATTEMPTS - entry.count });
});

app.post('/feuille-heures', handleFeuille);

const APP_PIN_PATH = path.join(__dirname, 'config', 'app-pin.json');

app.post('/api/app-login', (req, res) => {
  const pin = String(req.body.pin || '').trim();
  try {
    const cfg = JSON.parse(fs.readFileSync(APP_PIN_PATH, 'utf8'));
    return res.json({ success: pin === String(cfg.pin) });
  } catch (err) {
    logger.err(`App login : ${err.message}`);
    res.status(500).json({ success: false });
  }
});

app.get('/api/conges', async (_req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const today = new Date();
    const dateDebut = today.toISOString().split('T')[0];
    const fin = new Date(); fin.setMonth(fin.getMonth() + 5);
    const dateFin = fin.toISOString().split('T')[0];

    const LIMIT = 50;

    async function fetchPage(start) {
      const args = { dateDebut, dateFin, limit: LIMIT, start };
      logger.info(`[congés] fetchPage start=${start} args=${JSON.stringify(args)}`);
      const response = await fetch('https://srv1740888.hstgr.cloud/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'tools/call',
          params: { name: 'get_absences', arguments: args }
        })
      });
      const text = await response.text();
      logger.info(`[congés] réponse brute (500 chars) : ${text.slice(0, 500)}`);
      const lines = text.split('\n').filter(l => l.startsWith('data: '));
      const data = lines.map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
      const result = data.find(d => d.result)?.result;
      const content = result?.content?.[0]?.text;
      return content ? JSON.parse(content) : {};
    }

    let start = 0;
    let totalSize = null;
    let allResults = [];

    do {
      const page = await fetchPage(start);
      const results = page.results || [];
      allResults = allResults.concat(results);
      if (totalSize === null) totalSize = page.totalSize ?? results.length;
      logger.info(`[congés] page start=${start} → ${results.length} résultats, totalSize=${totalSize}`);
      start += LIMIT;
    } while (start < totalSize);

    const formatted = allResults.map(a => ({
      nom: a._embedded?.user?.fullName || a.fullName || '',
      type: a.subRequests?.[0]?.typeDescription || a.type || '',
      dateDebut: a.startDate || a.dateDebut,
      dateFin: a.endDate || a.dateFin,
      nbJours: a.nbDays || a.nbJours,
      statut: a.status || a.statut
    }));

    res.json(formatted);
  } catch (err) {
    logger.err(`API congés : ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard', (_req, res) => {
  try {
    const wb = readWorkbook();
    res.json({
      feuilles:  getSheetData(wb, 'Feuilles'),
      facture:   getSheetData(wb, 'Facture'),
      mapping:   getSheetData(wb, 'Mapping'),
      controles: getSheetData(wb, 'Controles'),
    });
  } catch (err) {
    logger.err(`Dashboard API : ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

const PDFS_DIR = path.join(__dirname, 'pdfs');

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

app.get('/api/pdfs', (_req, res) => {
  try {
    if (!fs.existsSync(PDFS_DIR)) return res.json([]);
    const files = fs.readdirSync(PDFS_DIR)
      .filter(f => f.toLowerCase().endsWith('.pdf'))
      .map(f => {
        const stat = fs.statSync(path.join(PDFS_DIR, f));
        return {
          nom:    f,
          url:    `/pdfs/${encodeURIComponent(f)}`,
          taille: formatSize(stat.size),
          date:   stat.mtime.toISOString().slice(0, 10),
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
    res.json(files);
  } catch (err) {
    logger.err(`API pdfs : ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pdfs/zip', (_req, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="pdfs-signes.zip"');
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => {
    logger.err(`ZIP pdfs : ${err.message}`);
    if (!res.headersSent) res.status(500).end();
  });
  archive.pipe(res);
  if (fs.existsSync(PDFS_DIR)) archive.directory(PDFS_DIR, false);
  archive.finalize();
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.ok(`Serveur DSN Automation démarré sur le port ${PORT}`);
  parserFacture.demarrer();
  parserMapping.demarrer();
});

// ── Safety net ───────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.err(`Exception non gérée : ${err.stack || err.message}`);
});

process.on('unhandledRejection', (reason) => {
  logger.err(`Promesse rejetée non gérée : ${reason}`);
});
