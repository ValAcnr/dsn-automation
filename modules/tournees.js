'use strict';
// Stockage et injection des soumissions "tournées journalières".
// Format : un fichier JSON par soumission dans data/tournees/submissions/
// Chaque soumission contient : zone, zone_name, date, responsable, submitted_at, rows[].

const fs           = require('fs');
const path         = require('path');
const { execFile } = require('child_process');

const SUBMISSIONS_DIR = path.join(__dirname, '..', 'data', 'tournees', 'submissions');
const FILL_SCRIPT     = path.join(__dirname, '..', 'fill_tournees.py');

// Chemin vers le fichier maître Excel — modifiable via variable d'environnement
// pour changer de période sans redéploiement.
const MASTER_XLSX = process.env.TOURNEES_MASTER_XLSX ||
  path.join(__dirname, '..', 'data', 'tournees', 'Tournées_journalières_Juillet_2026.xlsx');

// ── Verrou simple contre les exécutions concurrentes de fill_tournees.py ────
let _fillRunning = false;
let _fillPending = false;

function ensureDir() {
  if (!fs.existsSync(SUBMISSIONS_DIR)) fs.mkdirSync(SUBMISSIONS_DIR, { recursive: true });
}

// Lit toutes les soumissions depuis SUBMISSIONS_DIR (et le sous-dossier traite/ si présent).
function readAll() {
  const subs = [];
  const dirs = [SUBMISSIONS_DIR, path.join(SUBMISSIONS_DIR, 'traite')];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort();
    for (const f of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        // Chaque fichier contient une seule soumission (objet), mais on accepte
        // aussi un tableau pour la compatibilité avec des fichiers migrés.
        if (Array.isArray(raw)) subs.push(...raw);
        else subs.push(raw);
      } catch { /* fichier corrompu : ignoré */ }
    }
  }
  return subs;
}

// Écrit une soumission dans un fichier individuel et renvoie le nom du fichier.
function addSubmission(payload) {
  ensureDir();
  const safeZone = String(payload.zone || 'zone').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
  const date     = String(payload.date || 'nodate').replace(/[^0-9-]/g, '');
  const ts       = Date.now();
  const fname    = `${safeZone}_${date}_${ts}.json`;
  fs.writeFileSync(path.join(SUBMISSIONS_DIR, fname), JSON.stringify(payload, null, 2), 'utf8');
  return fname;
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
// Passe le dossier SUBMISSIONS_DIR (fill_tournees.py gère fichier ou dossier).
function runFillScript() {
  if (_fillRunning) { _fillPending = true; return; }
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
    [FILL_SCRIPT, '--master', MASTER_XLSX, '--submissions', SUBMISSIONS_DIR],
    { cwd: path.join(__dirname, '..') },
    (err, stdout, stderr) => {
      _fillRunning = false;
      if (stdout && stdout.trim()) console.log(stdout.trim());
      if (err) {
        console.error(`[tournées] fill_tournees.py échec : ${err.message}`);
        if (stderr && stderr.trim()) console.error(stderr.trim());
      }
      if (_fillPending) { _fillPending = false; runFillScript(); }
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
