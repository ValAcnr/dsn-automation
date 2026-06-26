'use strict';

const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const EXCEL_PATH = path.join(__dirname, '..', 'feuilles_heures_interimaires.xlsx');
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

const SHEET_HEADERS = {
  Feuilles: [
    'horodatage', 'entreprise', 'nom', 'prenom', 'telephone', 'semaine', 'agence', 'referent',
    'total_heures', 'total_paniers', 'statut', 'observations',
    'h_lundi',     'panier_lundi',     'site_lundi',
    'h_mardi',     'panier_mardi',     'site_mardi',
    'h_mercredi',  'panier_mercredi',  'site_mercredi',
    'h_jeudi',     'panier_jeudi',     'site_jeudi',
    'h_vendredi',  'panier_vendredi',  'site_vendredi',
    'h_samedi',    'panier_samedi',    'site_samedi',
    'h_dimanche',  'panier_dimanche',  'site_dimanche',
    'lien_pdf', 'num_document', 'hash_sha256', 'timestamp_date',
  ],
  Facture: [
    'nom', 'prenom', 'reference', 'semaine', 'numero_semaine', 'qualification',
    'heures_normales', 'heures_feries', 'paniers', 'taux_horaire', 'montant_ht',
    'agence', 'numero_facture', 'date_facture', 'client',
  ],
  Mapping: [
    'conducteur', 'vehicule', 'date', 'numero_semaine', 'groupe',
    'amplitude_totale', 'km_total', 'nb_trajets', 'statut_vehicule',
  ],
  Controles: [
    'nom', 'prenom', 'semaine', 'heures_signees', 'heures_facturees', 'ecart_facture',
    'statut_facture', 'heures_vehicule', 'ecart_mapping', 'vehicule_actif',
    'statut_mapping', 'niveau_alerte', 'detail',
  ],
};

// Serialise all writes to prevent concurrent access
let writeQueue = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function initWorkbook() {
  const wb = xlsx.utils.book_new();
  for (const [name, headers] of Object.entries(SHEET_HEADERS)) {
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([headers]), name);
  }
  xlsx.writeFile(wb, EXCEL_PATH);
  return wb;
}

function readWorkbook() {
  if (!fs.existsSync(EXCEL_PATH)) return initWorkbook();
  return xlsx.readFile(EXCEL_PATH);
}

function getSheetData(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  return xlsx.utils.sheet_to_json(ws, { defval: '' });
}

async function writeWorkbook(wb) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      xlsx.writeFile(wb, EXCEL_PATH);
      return;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        logger.warn(`Fichier Excel verrouillé — tentative ${attempt + 1}/${MAX_RETRIES} dans ${RETRY_DELAY_MS / 1000}s…`);
        await sleep(RETRY_DELAY_MS);
      } else {
        throw new Error(`Impossible d'écrire dans Excel après ${MAX_RETRIES} tentatives : ${err.message}`);
      }
    }
  }
}

async function _appendRow(sheetName, rowData) {
  const wb = readWorkbook();
  const headers = SHEET_HEADERS[sheetName];

  // Ensure sheet exists
  if (!wb.Sheets[sheetName]) {
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([headers]), sheetName);
  }

  const existing = getSheetData(wb, sheetName);
  const newRow = headers.map((h) => (rowData[h] !== undefined ? rowData[h] : ''));
  const aoa = [headers, ...existing.map((r) => headers.map((h) => (r[h] !== undefined ? r[h] : ''))), newRow];
  wb.Sheets[sheetName] = xlsx.utils.aoa_to_sheet(aoa);

  await writeWorkbook(wb);
}

async function _replaceSheet(sheetName, rows) {
  const wb = readWorkbook();
  const headers = SHEET_HEADERS[sheetName];
  const aoa = [headers, ...rows.map((r) => headers.map((h) => (r[h] !== undefined ? r[h] : '')))];

  if (!wb.Sheets[sheetName]) {
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(aoa), sheetName);
  } else {
    wb.Sheets[sheetName] = xlsx.utils.aoa_to_sheet(aoa);
  }

  await writeWorkbook(wb);
}

function appendRow(sheetName, rowData) {
  writeQueue = writeQueue.then(() => _appendRow(sheetName, rowData));
  return writeQueue;
}

function replaceSheet(sheetName, rows) {
  writeQueue = writeQueue.then(() => _replaceSheet(sheetName, rows));
  return writeQueue;
}

module.exports = { EXCEL_PATH, SHEET_HEADERS, readWorkbook, getSheetData, appendRow, replaceSheet };
