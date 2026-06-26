'use strict';

const express       = require('express');
const path          = require('path');
const fs            = require('fs');
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
