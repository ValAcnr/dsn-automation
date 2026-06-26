'use strict';

const express       = require('express');
const path          = require('path');
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
