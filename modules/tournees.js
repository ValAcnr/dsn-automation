'use strict';
// Stockage et injection des soumissions "tournées journalières".
// Accumulation dans data/tournees/submissions.json (tableau de soumissions).
// Chaque soumission contient : zone, zone_name, date, responsable, submitted_at, rows[].

const fs            = require('fs');
const path          = require('path');
const { execFile }  = require('child_process');

const SUBMISSIONS_FILE = path.join(__dirname, '..', 'data', 'tournees', 'submissions.json');
const FILL_SCRIPT      = path.join(__dirname, '..', 'fill_tournees.py');

// Chemin vers le fichier maître Excel — modifiable via variable d'environnement
// pour changer de période sans redéploiement.
const MASTER_XLSX = process.env.TOURNEES_MASTER_XLSX ||
  path.join(__dirname, '..', 'data', 'tournees', 'Tournées_journalières_Juillet_2026.xlsx');

// ── Verrou simple contre les exécutions concurrentes de fill_tournees.py ────
// openpyxl n'aime pas les écritures simultanées sur le même fichier xlsx.
let _fillRunning = false;
let _fillPending = false;

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
        zone:         sub.zone         || '',
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

// Lance fill_tournees.py en sous-processus après chaque soumission.
// Le verrou (_fillRunning / _fillPending) garantit qu'une seule instance tourne
// à la fois ; si une soumission arrive pendant l'exécution, on relance juste après.
function runFillScript() {
  if (_fillRunning) {
    _fillPending = true;
    return;
  }
  if (!fs.existsSync(MASTER_XLSX)) {
    console.warn(`[tournées] fill_tournees.py ignoré : fichier maître absent (${MASTER_XLSX})`);
    return;
  }
  if (!fs.existsSync(FILL_SCRIPT)) {
    console.warn(`[tournées] fill_tournees.py introuvable : ${FILL_SCRIPT}`);
    return;
  }

  _fillRunning = true;
  execFile(
    'python3',
    [FILL_SCRIPT, '--master', MASTER_XLSX, '--submissions', SUBMISSIONS_FILE],
    { cwd: path.join(__dirname, '..') },
    (err, stdout, stderr) => {
      _fillRunning = false;
      if (stdout && stdout.trim()) console.log(stdout.trim());
      if (err) {
        console.error(`[tournées] fill_tournees.py échec : ${err.message}`);
        if (stderr && stderr.trim()) console.error(stderr.trim());
      }
      if (_fillPending) {
        _fillPending = false;
        runFillScript();
      }
    }
  );
}

// Renvoie le chemin et les infos du fichier maître.
function masterInfo() {
  if (!fs.existsSync(MASTER_XLSX)) return { exists: false, path: MASTER_XLSX, mtime: null };
  const stat = fs.statSync(MASTER_XLSX);
  return {
    exists: true,
    path:   MASTER_XLSX,
    mtime:  stat.mtime.toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }),
  };
}

module.exports = { addSubmission, getFlatRows, runFillScript, masterInfo, MASTER_XLSX };
