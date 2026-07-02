'use strict';

const xlsx   = require('xlsx');
const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const EXCEL_PATH = path.join(__dirname, '..', 'controle_vehicules_v2.xlsx');
const SHEET_NAME = 'Controles';
const HEADERS    = [
  'date', 'type', 'immatriculation', 'nom', 'prenom',
  // champs type=vehicule
  'sangle', 'roue_secours', 'etat_interieur', 'etat_exterieur', 'photo_interieur', 'photo_exterieur',
  // champs type=papier
  'carte_grise', 'assurance', 'detail_assurance',
  'carte_total', 'num_carte_total',
  'permis', 'detail_permis',
  'feuille_location', 'constats',
  // commun
  'lien_pdf', 'sig_responsable', 'sig_conducteur',
];

let writeQueue = Promise.resolve();
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _write(wb) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      xlsx.writeFile(wb, EXCEL_PATH);
      return;
    } catch (err) {
      if (attempt < 3) {
        logger.warn(`controle_vehicules_v2.xlsx verrouillé — tentative ${attempt + 1}/3 dans 2 s…`);
        await sleep(2000);
      } else {
        throw new Error(`Impossible d'écrire controle_vehicules_v2.xlsx : ${err.message}`);
      }
    }
  }
}

function _wb() {
  if (fs.existsSync(EXCEL_PATH)) {
    const wb = xlsx.readFile(EXCEL_PATH);
    if (!wb.Sheets[SHEET_NAME]) {
      xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([HEADERS]), SHEET_NAME);
    }
    return wb;
  }
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([HEADERS]), SHEET_NAME);
  return wb;
}

async function _appendRow(rowData) {
  const wb       = _wb();
  const existing = xlsx.utils.sheet_to_json(wb.Sheets[SHEET_NAME], { defval: '' });
  const newRow   = HEADERS.map(h => (rowData[h] !== undefined ? rowData[h] : ''));
  const aoa      = [HEADERS, ...existing.map(r => HEADERS.map(h => (r[h] !== undefined ? r[h] : ''))), newRow];
  wb.Sheets[SHEET_NAME] = xlsx.utils.aoa_to_sheet(aoa);
  await _write(wb);
}

function appendRow(rowData) {
  writeQueue = writeQueue.then(() => _appendRow(rowData));
  return writeQueue;
}

function getAll() {
  if (!fs.existsSync(EXCEL_PATH)) return [];
  const wb = xlsx.readFile(EXCEL_PATH);
  if (!wb.Sheets[SHEET_NAME]) return [];
  return xlsx.utils.sheet_to_json(wb.Sheets[SHEET_NAME], { defval: '' })
    .slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

module.exports = { appendRow, getAll };
