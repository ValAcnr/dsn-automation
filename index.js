'use strict';

const express       = require('express');
const path          = require('path');
const fs            = require('fs');
const archiver      = require('archiver');
const { handleFeuille }            = require('./modules/webhook');
const { readWorkbook, getSheetData, replaceSheet } = require('./modules/excel');
const parserFacture = require('./modules/parser-facture');
const parserMapping = require('./modules/parser-mapping');
const logger        = require('./modules/logger');
const calcul          = require('./modules/calcul-controles');
const excelVehicules  = require('./modules/excel-vehicules');

const PORT = process.env.PORT || 3000;

function normStr(s) {
  return String(s || '').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function parseNumSemaine(semaine) {
  const s = String(semaine || '');
  const m = s.match(/\d{4}\.(\d{2})/) || s.match(/(\d{1,2})/);
  return m ? m[1].padStart(2, '0') : s;
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/pdfs',       express.static(path.join(__dirname, 'pdfs')));
app.use('/signatures', express.static(path.join(__dirname, 'signatures')));

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

    // Helper SSE parser + appel MCP générique
    async function callMcp(args) {
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
      const dataLines = text.split(/\r?\n/)
        .filter(l => /^data:/.test(l))
        .map(l => l.replace(/^data:\s*/, ''));
      const data = dataLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const result = data.find(d => d.result)?.result;
      const content = result?.content?.[0]?.text;
      return content ? JSON.parse(content) : {};
    }

    async function fetchPage(start) {
      const args = { dateDebut, dateFin, limit: LIMIT, start };
      logger.info(`[congés] fetchPage start=${start} args=${JSON.stringify(args)}`);
      return callMcp(args);
    }

    let start = 0;
    let totalSize = null;
    let allResults = [];
    let pagesCount = 0;

    do {
      const page = await fetchPage(start);
      const results = page.results || [];
      allResults = allResults.concat(results);
      if (totalSize === null) totalSize = page.totalSize ?? results.length;
      logger.info(`[congés] page start=${start} → ${results.length} résultats, totalSize=${totalSize}`);
      start += LIMIT;
      pagesCount++;
    } while (start < totalSize);

    logger.info(`[congés] pagination terminée : ${pagesCount} page(s), totalSize=${totalSize}, ${allResults.length} résultats bruts avant dedup`);

    // Déduplication par id (la dernière page Eurecia chevauche la précédente)
    allResults = [...new Map(allResults.map(r => [r.id, r])).values()];
    logger.info(`[congés] après dedup : ${allResults.length} entrées uniques`);

    const formatted = allResults.map(a => ({
      nom: a._embedded?.user?.fullName || a.fullName || '',
      type: a.subRequests?.[0]?.typeDescription || a.type || '',
      dateDebut: a.startDate || a.dateDebut,
      dateFin: a.endDate || a.dateFin,
      nbJours: a.nbDays || a.nbJours,
      statut: a.status || a.statut
    }));

    // LOG TEMPORAIRE — statuts bruts API (r.status) et statuts formatés (r.statut)
    logger.info('[congés] par statut brut (r.status) : ' + JSON.stringify(allResults.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {})));
    logger.info('[congés] par statut formaté (r.statut) : ' + JSON.stringify(formatted.reduce((acc, r) => { acc[r.statut] = (acc[r.statut] || 0) + 1; return acc; }, {})));

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
const SIG_DIR  = path.join(__dirname, 'signatures', 'controle_vehicules');

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

app.delete('/api/feuille', async (req, res) => {
  try {
    const nom      = String(req.body.nom      || '');
    const prenom   = String(req.body.prenom   || '');
    const semaine  = String(req.body.semaine  || '');
    const moisPaie = String(req.body.mois_paie || '').replace(/[^0-9]/g, '');
    if (!nom || !semaine) return res.status(400).json({ error: 'Paramètres manquants' });

    const rows = getSheetData(readWorkbook(), 'Feuilles');
    const idx  = rows.findIndex(r =>
      normStr(r.nom)    === normStr(nom) &&
      normStr(r.prenom) === normStr(prenom) &&
      parseNumSemaine(r.semaine) === parseNumSemaine(semaine) &&
      String(r.mois_paie || '').replace(/[^0-9]/g, '') === moisPaie
    );
    if (idx === -1) return res.status(404).json({ error: 'Feuille introuvable' });

    const lienPdf = rows[idx].lien_pdf;
    if (lienPdf) {
      try {
        const pdfPath = path.join(__dirname, String(lienPdf).replace(/^\.\//, ''));
        if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
      } catch (e) { logger.warn(`Suppression PDF : ${e.message}`); }
    }

    await replaceSheet('Feuilles', rows.filter((_, i) => i !== idx));
    await calcul.recalculer();
    logger.ok(`Feuille supprimée : ${nom} ${prenom} sem.${parseNumSemaine(semaine)}`);
    res.json({ status: 'ok' });
  } catch (err) {
    logger.err(`DELETE /api/feuille : ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/controle-vehicule', async (req, res) => {
  try {
    const lignes = Array.isArray(req.body) ? req.body : [];
    if (!lignes.length) return res.status(400).json({ error: 'Tableau vide' });

    if (!fs.existsSync(SIG_DIR)) fs.mkdirSync(SIG_DIR, { recursive: true });

    const saveSig = (b64field, fname) => {
      if (!b64field) return '';
      const b64 = String(b64field).replace(/^data:image\/[a-z]+;base64,/, '');
      fs.writeFileSync(path.join(SIG_DIR, fname), Buffer.from(b64, 'base64'));
      return `./signatures/controle_vehicules/${fname}`;
    };

    for (let i = 0; i < lignes.length; i++) {
      const l         = lignes[i];
      const safeImmat = String(l.immatriculation || 'INCONNUE').toUpperCase().replace(/[^A-Z0-9]/g, '_');
      const safeDate  = String(l.date || new Date().toISOString().slice(0, 10)).replace(/[^0-9]/g, '');
      const uid       = `${safeImmat}_${safeDate}_${Date.now() + i}`;

      const sigResp = saveSig(l.signatureResponsable, `${uid}_responsable.png`);
      const sigCond = saveSig(l.signatureConducteur,  `${uid}_conducteur.png`);

      await excelVehicules.appendRow({
        date:            l.date || new Date().toISOString().slice(0, 10),
        immatriculation: l.immatriculation || '',
        conducteur:      l.conducteur      || '',
        sangle:          l.sangle ? 'Oui' : 'Non',
        sig_responsable: sigResp,
        sig_conducteur:  sigCond,
      });

      logger.ok(`Contrôle véhicule : ${l.immatriculation} / ${l.conducteur}`);
    }

    res.json({ status: 'ok', count: lignes.length });
  } catch (err) {
    logger.err(`POST /api/controle-vehicule : ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

const VEHICULES_XLSX = path.join(__dirname, 'controle_vehicules.xlsx');

app.get('/api/controle-vehicule/liste', (_req, res) => {
  try {
    res.json(excelVehicules.getAll());
  } catch (err) {
    logger.err(`GET /api/controle-vehicule/liste : ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/controle-vehicule', async (req, res) => {
  try {
    const { sig_responsable, sig_conducteur, date, immatriculation, conducteur } = req.body || {};
    const removed = await excelVehicules.removeRow({ sig_responsable, sig_conducteur, date, immatriculation, conducteur });
    if (!removed) return res.status(404).json({ error: 'Entrée introuvable' });
    const delPng = p => {
      if (!p) return;
      try {
        const abs = path.join(__dirname, String(p).replace(/^\.\//, ''));
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch (e) { logger.warn(`Suppression PNG véhicule : ${e.message}`); }
    };
    delPng(removed.sig_responsable);
    delPng(removed.sig_conducteur);
    logger.ok(`Contrôle véhicule supprimé : ${removed.immatriculation} / ${removed.conducteur}`);
    res.json({ status: 'ok' });
  } catch (err) {
    logger.err(`DELETE /api/controle-vehicule : ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/controle-vehicule/export', (req, res) => {
  if (!fs.existsSync(VEHICULES_XLSX)) {
    return res.status(404).json({ error: 'Aucun contrôle véhicule enregistré pour le moment.' });
  }
  res.download(VEHICULES_XLSX, 'controle_vehicules.xlsx', err => {
    if (err && !res.headersSent) {
      logger.err(`Export controle_vehicules.xlsx : ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });
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
