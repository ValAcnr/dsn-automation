'use strict';
// Stockage des soumissions de l'outil "tournées journalières".
// Accumulation dans data/tournees/submissions.json (tableau de soumissions).
// Chaque soumission contient : zone, zone_name, date, responsable, submitted_at, rows[].

const fs   = require('fs');
const path = require('path');

const SUBMISSIONS_FILE = path.join(__dirname, '..', 'data', 'tournees', 'submissions.json');

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
  // Tri : date desc, puis heure d'envoi desc
  flat.sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') ||
    (b.submitted_at || '').localeCompare(a.submitted_at || '')
  );
  return flat;
}

module.exports = { addSubmission, getFlatRows };
