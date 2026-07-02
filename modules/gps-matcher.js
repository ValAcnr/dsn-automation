'use strict';

const fs   = require('fs');
const path = require('path');

const GPS_FILE = path.join(__dirname, '..', 'data', 'gps-hours.json');

// ── Normalisation des noms ────────────────────────────────────────────────────
// Supprime les accents, met en majuscules, collapse les espaces,
// puis trie les mots alphabétiquement pour gérer "Jessy GONCALVES" ↔ "GONCALVES Jessy"
function normName(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().trim()
    .replace(/\s+/g, ' ')
    .split(' ').sort().join(' ');
}

function matchDriverName(nomFeuille, driverNameGps) {
  const a = normName(nomFeuille);
  const b = normName(driverNameGps);
  return a.length > 0 && b.length > 0 && a === b;
}

// ── Dates ISO d'une semaine (lun → dim) ──────────────────────────────────────
// Semaine ISO 8601 : la semaine 1 est celle qui contient le premier jeudi de l'année
function isoWeekDates(sem, annee) {
  // Le 4 janvier est toujours dans la semaine 1
  const jan4     = new Date(annee, 0, 4);
  const dowJan4  = (jan4.getDay() + 6) % 7;   // lundi = 0
  const week1Mon = new Date(jan4);
  week1Mon.setDate(jan4.getDate() - dowJan4);  // lundi de la semaine 1
  const targetMon = new Date(week1Mon);
  targetMon.setDate(week1Mon.getDate() + (sem - 1) * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(targetMon);
    d.setDate(targetMon.getDate() + i);
    return d;
  });
}

// ── Extraction numéro de semaine + année ─────────────────────────────────────
// Gère "2026.24", "24", "S24", "SEM24", "24/2026"
function parseWeekAndYear(semaine) {
  const s    = String(semaine || '');
  const full = s.match(/(\d{4})\.(\d{1,2})/);
  if (full) return { annee: parseInt(full[1]), semaine: parseInt(full[2]) };
  const slashFmt = s.match(/(\d{1,2})\/(\d{4})/);
  if (slashFmt) return { annee: parseInt(slashFmt[2]), semaine: parseInt(slashFmt[1]) };
  const num = s.match(/(\d{1,2})/);
  return { annee: new Date().getFullYear(), semaine: num ? parseInt(num[1]) : 0 };
}

// ── Récupère les heures GPS d'un conducteur sur les 7 jours d'une semaine ────
// nomInterimaire : "NOM Prénom" (ou n'importe quel ordre, matchDriverName gère les deux)
// semaine        : numéro de semaine (int ou string comme "2026.24")
// annee          : int (optionnel si inclus dans semaine)
// Retourne { totalHeuresGps, joursTrouves } ou null si aucun jour trouvé
function getGpsHoursForWeek(nomInterimaire, semaine, annee) {
  if (!fs.existsSync(GPS_FILE)) return null;

  let allDays;
  try { allDays = JSON.parse(fs.readFileSync(GPS_FILE, 'utf8')); }
  catch { return null; }

  const parsed = parseWeekAndYear(semaine);
  const sem    = typeof semaine === 'number' ? semaine : parsed.semaine;
  const yr     = annee ? parseInt(annee) : parsed.annee;
  if (!sem || !yr) return null;

  const dates = isoWeekDates(sem, yr);

  let totalSeconds = 0;
  let joursTrouves = 0;

  for (const d of dates) {
    const dateKey = d.toISOString().split('T')[0];   // "2026-06-30"
    const dayData = allDays[dateKey];
    if (!dayData || typeof dayData !== 'object') continue;

    for (const driverInfo of Object.values(dayData)) {
      if (matchDriverName(nomInterimaire, driverInfo.driverName || '')) {
        totalSeconds += typeof driverInfo.totalSeconds === 'number' ? driverInfo.totalSeconds : 0;
        joursTrouves++;
        break;   // un seul match par jour
      }
    }
  }

  if (joursTrouves === 0) return null;
  return {
    totalHeuresGps: Math.round(totalSeconds / 36) / 100,   // 2 décimales
    joursTrouves,
  };
}

module.exports = { normName, matchDriverName, isoWeekDates, parseWeekAndYear, getGpsHoursForWeek };
