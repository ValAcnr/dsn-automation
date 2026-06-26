'use strict';

const express       = require('express');
const { handleFeuille } = require('./modules/webhook');
const parserFacture = require('./modules/parser-facture');
const parserMapping = require('./modules/parser-mapping');
const logger        = require('./modules/logger');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '50mb' }));

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
