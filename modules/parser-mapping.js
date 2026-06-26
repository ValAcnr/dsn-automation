'use strict';

const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const chokidar = require('chokidar');
const { appendRow } = require('./excel');
const calcul = require('./calcul-controles');
const logger = require('./logger');

const ENTREE_DIR  = path.join(__dirname, '..', 'mapping_entrees');
const TRAITE_DIR  = path.join(__dirname, '..', 'mapping_traites');

function ensureDirs() {
  for (const d of [ENTREE_DIR, TRAITE_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

// Parse HH:MM:SS or HH:MM amplitude to decimal hours
function parseAmplitude(str) {
  if (!str) return 0;
  const parts = String(str).trim().split(':').map(Number);
  if (parts.length === 3) return parts[0] + parts[1] / 60 + parts[2] / 3600;
  if (parts.length === 2) return parts[0] + parts[1] / 60;
  return parseFloat(String(str).replace(',', '.')) || 0;
}

// ISO 8601 week number
function getISOWeek(dateStr) {
  let d;
  if (!dateStr) return '';
  if (/\d{2}\/\d{2}\/\d{4}/.test(dateStr)) {
    const [dd, mm, yyyy] = dateStr.split('/');
    d = new Date(Date.UTC(+yyyy, +mm - 1, +dd));
  } else {
    d = new Date(dateStr);
  }
  if (isNaN(d.getTime())) return '';
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return String(Math.ceil(((d - yearStart) / 86400000 + 1) / 7)).padStart(2, '0');
}

// Normalise CSV header to a stable ASCII key
function normHeader(h) {
  return (h || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function parseCSV(buffer) {
  const text = iconv.decode(buffer, 'latin1');
  const lines = text.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  if (lines.length < 2) return [];

  const rawHeaders = lines[0].split(';');
  const headers = rawHeaders.map(normHeader);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(';');
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (cells[idx] || '').trim(); });
    rows.push(obj);
  }
  return rows;
}

// Map normalised CSV columns to the canonical fields we need
function extractFields(row) {
  const get = (...keys) => {
    for (const k of keys) {
      if (row[k] !== undefined && row[k] !== '') return row[k];
    }
    return '';
  };

  // Amplitude column may be named "amplitude_horaire", "amplitude", etc.
  const ampKey = Object.keys(row).find((k) => k.startsWith('amplitude'));

  return {
    vehicule:   get('vehicule', 'vehicle', 'immatriculation'),
    conducteur: get('conducteur', 'driver', 'chauffeur', 'pilote'),
    date:       get('date', 'jour', 'date_trajet'),
    groupe:     get('groupe', 'group'),
    amplitude:  ampKey ? row[ampKey] : get('amplitude'),
    km:         get('km', 'kms', 'kilometres', 'distance'),
  };
}

// Aggregate raw rows by (conducteur, date) and compute per-day stats
function agreger(rawRows) {
  const map = new Map();

  for (const raw of rawRows) {
    const { vehicule, conducteur, date, groupe, amplitude, km } = extractFields(raw);
    if (!conducteur || !date) continue;

    // Normalise conducteur: collapse double spaces
    const cond = conducteur.replace(/\s+/g, ' ').trim();
    const key = `${cond.toUpperCase()}|${date}`;

    if (!map.has(key)) {
      map.set(key, { conducteur: cond, vehicule, date, groupe, ampH: 0, kmTotal: 0, nbTrajets: 0 });
    }

    const e = map.get(key);
    e.ampH     += parseAmplitude(amplitude);
    e.kmTotal  += parseFloat(String(km).replace(',', '.')) || 0;
    e.nbTrajets += 1;
    if (!e.vehicule && vehicule) e.vehicule = vehicule;
  }

  const result = [];
  for (const e of map.values()) {
    const ampH = Math.round(e.ampH * 100) / 100;
    const statutVehicule = ampH === 0 ? 'IMMOBILE' : ampH < 0.5 ? 'INACTIF' : 'ACTIF';

    result.push({
      conducteur:      e.conducteur,
      vehicule:        e.vehicule,
      date:            e.date,
      numero_semaine:  getISOWeek(e.date),
      groupe:          e.groupe,
      amplitude_totale: ampH,
      km_total:        Math.round(e.kmTotal * 10) / 10,
      nb_trajets:      e.nbTrajets,
      statut_vehicule: statutVehicule,
    });
  }

  return result;
}

async function traiterCSV(filePath) {
  const filename = path.basename(filePath);
  try {
    logger.info(`Traitement CSV Mapping Control : ${filename}`);
    const buffer  = fs.readFileSync(filePath);
    const rawRows = parseCSV(buffer);
    const rows    = agreger(rawRows);

    if (rows.length === 0) {
      logger.warn(`Aucune ligne exploitable dans le CSV : ${filename}`);
    }

    for (const row of rows) {
      await appendRow('Mapping', row);
    }

    await calcul.recalculer();

    const dest = path.join(TRAITE_DIR, filename);
    fs.renameSync(filePath, dest);

    logger.ok(`CSV Mapping ${filename} traité — ${rows.length} ligne(s) agrégée(s)`);
  } catch (err) {
    logger.err(`Erreur traitement CSV Mapping ${filename} : ${err.message}`);
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
    if (path.extname(filePath).toLowerCase() === '.csv') {
      await traiterCSV(filePath);
    }
  });

  watcher.on('error', (err) => logger.err(`Surveillance mapping_entrees : ${err.message}`));

  logger.info(`Surveillance démarrée : ${ENTREE_DIR}`);
}

module.exports = { demarrer };
