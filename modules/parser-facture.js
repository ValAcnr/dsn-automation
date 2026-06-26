'use strict';

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const chokidar = require('chokidar');
const { appendRow } = require('./excel');
const calcul = require('./calcul-controles');
const logger = require('./logger');

const ENTREE_DIR  = path.join(__dirname, '..', 'factures_entrees');
const TRAITEE_DIR = path.join(__dirname, '..', 'factures_traitees');

function ensureDirs() {
  for (const d of [ENTREE_DIR, TRAITEE_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function parseFloat2(s) {
  return parseFloat(String(s || '').replace(',', '.')) || 0;
}

/**
 * Strip repeated page-header boilerplate blocks.
 * Each page header starts with "Dom RH" (the agency name) and ends with "Naf %6"
 * (a template variable that appears at the bottom of every page header).
 */
function stripPageHeaders(text) {
  return text.replace(/Dom RH[\s\S]*?Naf\s*%6[^\n]*/g, '');
}

/**
 * Split a "NOM... Prenom" string into its parts.
 * Convention: NOM = all-uppercase words, Prenom = last word(s) with lowercase letters.
 * Handles compound names like "TEIXEIRA DE ALMEIDA Tiago".
 */
function splitNomPrenom(str) {
  const words = str.trim().split(/\s+/);
  let prenomIdx = words.length - 1;
  for (let i = words.length - 1; i >= 0; i--) {
    if (/[a-z]/.test(words[i])) { prenomIdx = i; break; }
  }
  return {
    nom:    words.slice(0, prenomIdx).join(' '),
    prenom: words.slice(prenomIdx).join(' '),
  };
}

/**
 * Extract 3 consecutive French decimal numbers glued at end of line.
 * Example: "NAV-AP 94-78Hrs normales (02-02/01)7,0022,84159,88"
 *   → { qte: 7, taux: 22.84, montant: 159.88, prefix: "NAV-AP 94-78Hrs normales (02-02/01)" }
 *
 * Numbers use comma as decimal separator, exactly 2 decimal digits: \d+,\d{2}
 * They are concatenated with no separator between them.
 */
function extract3(line) {
  const m = line.match(/(\d+,\d{2})(\d+,\d{2})(\d+,\d{2})\s*$/);
  if (!m) return null;
  return {
    qte:     parseFloat2(m[1]),
    taux:    parseFloat2(m[2]),
    montant: parseFloat2(m[3]),
    prefix:  line.slice(0, m.index).trim(),
  };
}

/**
 * Extract 2 consecutive French numbers from a subtotal line.
 * Example: "Semaine 2026.01 CHAUFFEUR VL H/F35,00849,90"
 *   → { qte: 35, montant: 849.90 }
 */
function extract2(line) {
  const m = line.match(/(\d+,\d{2})(\d+,\d{2})\s*$/);
  if (!m) return null;
  return {
    qte:     parseFloat2(m[1]),
    montant: parseFloat2(m[2]),
  };
}

/**
 * Parse a Dom RH invoice PDF (real format observed from production invoices).
 *
 * Structure per worker per week:
 *   DIAS Gael Semaine 2026.01          ← worker header
 *   CHAUFFEUR VL H/F                   ← qualification
 *   NAV-AP 94-78Hrs normales (02-02/01)7,0022,84159,88   ← ref+description+QTE+TAUX+MONTANT
 *   Prévoyance intérimaire7,000,060,42
 *   Mutuelle intérimaire7,000,060,42
 *   Indemnité Panier jour1,009,269,26
 *   Semaine 2026.01 CHAUFFEUR VL H/F7,00169,98   ← weekly subtotal (QTE + MONTANT only)
 *
 * One Excel row is produced per worker per week when the subtotal line is encountered.
 */
function parseFactureDomRH(text) {
  // Extract invoice metadata before stripping (metadata is in the page headers)
  let numeroFacture = '';
  let dateFacture   = '';
  const client = 'AEL Services';
  const agence = 'Dom RH';

  const rawLines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of rawLines) {
    // Standalone invoice number: a line containing only 4-6 digits (e.g. "4894")
    if (!numeroFacture && /^\d{4,6}$/.test(line)) {
      numeroFacture = line;
    }
    // "Date 31/01/2026"
    if (!dateFacture) {
      const m = line.match(/^Date\s+(\d{2}\/\d{2}\/\d{4})/);
      if (m) dateFacture = m[1];
    }
  }

  // Remove page headers and parse content
  const cleaned = stripPageHeaders(text);
  const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);

  const rows = [];

  // Accumulator state for the current worker+week section
  let nom = '', prenom = '', semaine = '', numSem = '', qualif = '';
  let ref = '', tauxHN = 0;
  let accNorm = 0, accFer = 0, accPan = 0;

  function emitRow(montantHT) {
    if (!nom || !semaine) return;
    rows.push({
      nom, prenom,
      reference:       ref,
      semaine,
      numero_semaine:  numSem,
      qualification:   qualif,
      heures_normales: Math.round(accNorm * 100) / 100,
      heures_feries:   Math.round(accFer  * 100) / 100,
      paniers:         Math.round(accPan  * 100) / 100,
      taux_horaire:    tauxHN,
      montant_ht:      montantHT,
      agence,
      numero_facture:  numeroFacture,
      date_facture:    dateFacture,
      client,
    });
    // Reset per-week accumulators, keep nom/prenom/qualif for potential next week
    ref = ''; tauxHN = 0; accNorm = 0; accFer = 0; accPan = 0;
  }

  for (const line of lines) {

    // ── Worker + week header ─────────────────────────────────────────────────
    // "DIAS Gael Semaine 2026.01"  or  "TEIXEIRA DE ALMEIDA  Tiago Semaine 2026.02"
    // Must not start with "Semaine" itself (those are subtotal lines)
    const mWorker = !line.startsWith('Semaine') &&
      line.match(/^(.+?)\s+Semaine\s+(\d{4}\.\d{2})\s*$/);
    if (mWorker) {
      const parts = splitNomPrenom(mWorker[1]);
      nom     = parts.nom;
      prenom  = parts.prenom;
      semaine = mWorker[2];
      numSem  = semaine.split('.')[1];
      qualif  = '';
      ref = ''; tauxHN = 0; accNorm = 0; accFer = 0; accPan = 0;
      continue;
    }

    // ── Qualification ─────────────────────────────────────────────────────────
    // "CHAUFFEUR VL H/F"  (no decimal numbers, starts with known keyword)
    if (/^(CHAUFFEUR|CONDUCTEUR|AGENT|CARISTE|MANUTENTIONNAIRE|OPERATEUR)/i.test(line) &&
        !/\d,\d{2}/.test(line)) {
      qualif = line;
      continue;
    }

    // ── Weekly subtotal ───────────────────────────────────────────────────────
    // "Semaine 2026.01 CHAUFFEUR VL H/F7,00169,98"
    if (/^Semaine\s+\d{4}\.\d{2}\s/.test(line)) {
      const nums = extract2(line);
      if (nums) emitRow(nums.montant);
      continue;
    }

    // ── Worker grand total ────────────────────────────────────────────────────
    // "DIAS Gael 147,003 569,58"  — numbers have thousands-space separator → skip
    // These won't match extract3 due to the space in the number, so naturally ignored.

    if (!nom) continue;

    // ── Detail lines ─────────────────────────────────────────────────────────
    const nums = extract3(line);
    if (!nums) continue;

    if (/Hrs?\s*norm/i.test(line)) {
      // "NAV-AP 94-78Hrs normales (02-02/01)7,0022,84159,88"
      // "Hrs normales (16-16/01)7,0022,84159,88"  ← continuation, no ref prefix
      accNorm += nums.qte;
      if (!tauxHN) tauxHN = nums.taux;
      // Capture reference code: text before "Hrs" that is NOT itself "Hrs..."
      if (!ref && nums.prefix && !/^Hrs/i.test(nums.prefix)) {
        ref = nums.prefix.replace(/Hrs.*/i, '').trim();
      }

    } else if (/Hrs?\s*[Ff][eé]ri/i.test(line)) {
      // "Hrs Fériés n Trav7,0022,84159,88"
      accFer += nums.qte;

    } else if (/[Pp]anier/i.test(line)) {
      // "Indemnité Panier jour1,009,269,26"
      accPan += nums.qte;
    }
    // Prévoyance intérimaire, Mutuelle intérimaire → intentionally ignored
  }

  return rows;
}

async function traiterFacture(filePath) {
  const filename = path.basename(filePath);
  try {
    logger.info(`Traitement facture PDF : ${filename}`);
    const buffer = fs.readFileSync(filePath);
    const parsed = await pdfParse(buffer);
    const rows   = parseFactureDomRH(parsed.text);

    if (rows.length === 0) {
      logger.warn(`Aucune ligne extraite de la facture : ${filename} — vérifier le format du PDF`);
    }

    for (const row of rows) {
      await appendRow('Facture', row);
    }

    await calcul.recalculer();

    fs.renameSync(filePath, path.join(TRAITEE_DIR, filename));
    logger.ok(`Facture ${filename} traitée — ${rows.length} ligne(s) importée(s)`);
  } catch (err) {
    logger.err(`Erreur traitement facture ${filename} : ${err.message}`);
  }
}

function demarrer() {
  ensureDirs();

  const watcher = chokidar.watch(ENTREE_DIR, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
  });

  watcher.on('add', async (filePath) => {
    if (path.extname(filePath).toLowerCase() === '.pdf') {
      await traiterFacture(filePath);
    }
  });

  watcher.on('error', (err) => logger.err(`Surveillance factures_entrees : ${err.message}`));
  logger.info(`Surveillance démarrée : ${ENTREE_DIR}`);
}

module.exports = { demarrer };
