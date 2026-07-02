'use strict';

const xlsx   = require('xlsx');
const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const EXCEL_PATH = path.join(__dirname, '..', 'controle_vehicules.xlsx');
const SHEET_NAME = 'Vehicules';
const HEADERS    = [
  'date', 'immatriculation', 'conducteur', 'sangle',
  'mode', 'carte_total', 'num_carte_total', 'assurance', 'num_assurance', 'depot',
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
        logger.warn(`controle_vehicules.xlsx verrouillé — tentative ${attempt + 1}/3 dans 2 s…`);
        await sleep(2000);
      } else {
        throw new Error(`Impossible d'écrire controle_vehicules.xlsx : ${err.message}`);
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
  const rows = xlsx.utils.sheet_to_json(wb.Sheets[SHEET_NAME], { defval: '' });
  return rows.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

async function _removeRow(key) {
  if (!fs.existsSync(EXCEL_PATH)) return null;
  const wb   = xlsx.readFile(EXCEL_PATH);
  if (!wb.Sheets[SHEET_NAME]) return null;
  const rows = xlsx.utils.sheet_to_json(wb.Sheets[SHEET_NAME], { defval: '' });
  let idx = -1;
  if (key.sig_responsable) idx = rows.findIndex(r => r.sig_responsable === key.sig_responsable);
  if (idx === -1 && key.sig_conducteur) idx = rows.findIndex(r => r.sig_conducteur === key.sig_conducteur);
  if (idx === -1) idx = rows.findIndex(r =>
    r.date === key.date && r.immatriculation === key.immatriculation && r.conducteur === key.conducteur
  );
  if (idx === -1) return null;
  const removed = rows[idx];
  const aoa = [HEADERS, ...rows.filter((_, i) => i !== idx).map(r => HEADERS.map(h => (r[h] !== undefined ? r[h] : '')))];
  wb.Sheets[SHEET_NAME] = xlsx.utils.aoa_to_sheet(aoa);
  await _write(wb);
  return removed;
}

function removeRow(key) {
  writeQueue = writeQueue.then(() => _removeRow(key));
  return writeQueue;
}

module.exports = { appendRow, getAll, removeRow };
