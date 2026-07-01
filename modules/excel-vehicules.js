'use strict';

const xlsx   = require('xlsx');
const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const EXCEL_PATH = path.join(__dirname, '..', 'controle_vehicules.xlsx');
const SHEET_NAME = 'Vehicules';
const HEADERS    = ['date', 'immatriculation', 'conducteur', 'sangle', 'sig_responsable', 'sig_conducteur'];

let writeQueue = Promise.resolve();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _appendRow(rowData) {
  let wb;
  if (fs.existsSync(EXCEL_PATH)) {
    wb = xlsx.readFile(EXCEL_PATH);
  } else {
    wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([HEADERS]), SHEET_NAME);
  }
  if (!wb.Sheets[SHEET_NAME]) {
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([HEADERS]), SHEET_NAME);
  }
  const existing = xlsx.utils.sheet_to_json(wb.Sheets[SHEET_NAME], { defval: '' });
  const newRow   = HEADERS.map(h => (rowData[h] !== undefined ? rowData[h] : ''));
  const aoa      = [HEADERS, ...existing.map(r => HEADERS.map(h => (r[h] !== undefined ? r[h] : ''))), newRow];
  wb.Sheets[SHEET_NAME] = xlsx.utils.aoa_to_sheet(aoa);
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

function appendRow(rowData) {
  writeQueue = writeQueue.then(() => _appendRow(rowData));
  return writeQueue;
}

module.exports = { appendRow };
