'use strict';
// Stockage des soumissions de l'outil "tournées journalières".
// Accumulation dans data/tournees/submissions.json (tableau de soumissions).
// Chaque soumission contient : zone, zone_name, date, responsable, submitted_at, rows[].

const fs   = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const SUBMISSIONS_FILE  = path.join(__dirname, '..', 'data', 'tournees', 'submissions.json');
const SITES_CONFIG_PATH = path.join(__dirname, '..', 'public', 'tournees', 'sites_config.json');

function ensureDir() {
  const dir = path.dirname(SUBMISSIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readAll() {
  try {
    if (fs.existsSync(SUBMISSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(SUBMISSIONS_FILE, 'utf8'));
    }
  } catch { /* fichier corrompu ou absent : on repart à zéro */ }
  return [];
}

function loadSitesConfig() {
  try {
    return JSON.parse(fs.readFileSync(SITES_CONFIG_PATH, 'utf8'));
  } catch {
    return { zones: {} };
  }
}

// Ajoute une soumission et renvoie le nombre total de soumissions.
function addSubmission(payload) {
  ensureDir();
  const all = readAll();
  all.push(payload);
  fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(all, null, 2), 'utf8');
  return all.length;
}

// Renvoie les lignes aplaties (une par tournée) triées par date desc.
function getFlatRows() {
  const all = readAll();
  const flat = [];
  for (const sub of all) {
    const heureEnvoi = sub.submitted_at
      ? new Date(sub.submitted_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      : '';
    for (const row of (sub.rows || [])) {
      flat.push({
        date:         sub.date         || '',
        zone:         sub.zone         || '',       // identifiant de zone (clé dans sites_config)
        zone_name:    sub.zone_name    || sub.zone || '',
        site:         row.site         || '',
        tournee:      row.tournee      || '',
        chauffeur:    row.chauffeur    || '',
        vehicule:     row.vehicule     || '',
        observations: row.observations || '',
        responsable:  sub.responsable  || '',
        heure_envoi:  heureEnvoi,
        submitted_at: sub.submitted_at || '',
      });
    }
  }
  flat.sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') ||
    (b.submitted_at || '').localeCompare(a.submitted_at || '')
  );
  return flat;
}

// Sanitise un nom pour en faire un nom de feuille xlsx valide (≤ 31 car, sans / \ ? * [ ] :)
function safeSheetName(name) {
  return String(name || 'Feuille')
    .replace(/[\/\\?\*\[\]:]/g, '-')
    .slice(0, 31)
    .trim();
}

// Construit un classeur xlsx pour une zone donnée (une feuille par site).
// Structure des feuilles :
//   En-tête : N° TOURNÉE | DATE | CHAUFFEUR | VÉHICULE | OBSERVATIONS...
//   Lignes  : groupées par tournée ; le nom de tournée n'apparaît que sur la
//             première ligne de son groupe ; toutes les dates de la zone sont
//             listées, chauffeur/véhicule/observations remplis seulement si
//             une soumission correspondante existe.
function buildZoneWorkbook(zoneId) {
  const cfg  = loadSitesConfig();
  const zone = cfg.zones && cfg.zones[zoneId];
  if (!zone) throw new Error(`Zone inconnue : ${zoneId}`);

  // Lookup soumissions : "site||tournee||date" → { chauffeur, vehicule, observations }
  // En cas de doublons, on garde la soumission la plus récente (submitted_at desc).
  const lookup = {};
  for (const sub of readAll()) {
    if ((sub.zone || sub.site) !== zoneId) continue;
    const date = sub.date || '';
    for (const row of (sub.rows || [])) {
      const key = `${row.site || ''}||${row.tournee || ''}||${date}`;
      const ts  = sub.submitted_at || '';
      if (!lookup[key] || ts > lookup[key]._ts) {
        lookup[key] = {
          chauffeur:    row.chauffeur    || '',
          vehicule:     row.vehicule     || '',
          observations: row.observations || '',
          _ts:          ts,
        };
      }
    }
  }

  const wb    = xlsx.utils.book_new();
  const dates = zone.dates || [];

  for (const site of (zone.sites || [])) {
    const aoa = [[
      'N° TOURNÉE', 'DATE', 'CHAUFFEUR', 'VÉHICULE',
      'OBSERVATIONS / CHAUFFEUR REMPLACÉ + MOTIF',
    ]];

    for (const tourneeName of (site.tournees || [])) {
      let first = true;
      for (const date of dates) {
        const fill = lookup[`${site.name}||${tourneeName}||${date}`];
        aoa.push([
          first ? tourneeName : '',
          date,
          fill ? fill.chauffeur    : '',
          fill ? fill.vehicule     : '',
          fill ? fill.observations : '',
        ]);
        first = false;
      }
    }

    const ws = xlsx.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [14, 12, 25, 14, 45].map(w => ({ wch: w }));
    xlsx.utils.book_append_sheet(wb, ws, safeSheetName(site.name));
  }

  return wb;
}

module.exports = { addSubmission, getFlatRows, buildZoneWorkbook, loadSitesConfig };
