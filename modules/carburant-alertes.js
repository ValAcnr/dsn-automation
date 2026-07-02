'use strict';
// Analyse des transactions carburant : 3 règles d'alerte.
// Règle A — Écart consommation théorique
// Règle B — Transaction hors roulage (API Mapping)
// Règle C — Prix au litre anormal

const fs         = require('fs');
const path       = require('path');
const mappingApi = require('./mapping-api');

const DATA_FILE   = path.join(__dirname, '..', 'data', 'carburant-alertes.json');
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'prix-carburant-reference.json');

const SEUIL_CONSO = 0.15;  // +15 % sur litres théoriques → ÉCART_CONSO
const SEUIL_PRIX  = 0.15;  // +15 % sur prix référence → PRIX_ANORMAL
const CONSO_DEFAUT = 28;   // L/100 km si l'API ne fournit pas de valeur

// ── Chargement config prix ────────────────────────────────────────────────────
function loadPrixRef() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch { /* utilise les défauts */ }
  return { gazole: 1.75, sp95: 1.90, sp98: 1.95, defaut: 1.75 };
}

function normProduit(p) {
  const s = String(p || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (s.includes('gaz') || s.includes('go') || s.includes('dies') || s.includes('b7')) return 'gazole';
  if (s.includes('95')) return 'sp95';
  if (s.includes('98')) return 'sp98';
  return 'defaut';
}

// ── Delta km (Règle A) ────────────────────────────────────────────────────────
// Calcule les km parcourus depuis la transaction précédente sur le même véhicule.
function computeDeltaKm(transactions) {
  const prevByImmat = {};  // immat → { km, idx }
  for (const t of transactions) {
    if (!t.immatriculation) { t._deltaKm = null; continue; }
    const prev = prevByImmat[t.immatriculation];
    if (!prev || t.kilometrage === null) {
      t._deltaKm = null;
    } else {
      const delta = t.kilometrage - prev.km;
      t._deltaKm = delta >= 0 ? delta : null;  // ignore les km décroissants (erreur saisie)
    }
    if (t.kilometrage !== null) {
      prevByImmat[t.immatriculation] = { km: t.kilometrage };
    }
  }
}

// ── Analyse principale ────────────────────────────────────────────────────────
async function analyserTransactions(transactions, opts = {}) {
  const { skipMappingApi = false } = opts;

  // Trier par (immat, datetime) pour que le delta km soit correct
  transactions.sort((a, b) =>
    (a.immatriculation || '').localeCompare(b.immatriculation || '') ||
    (a.datetime || '').localeCompare(b.datetime || '')
  );
  computeDeltaKm(transactions);

  const prixRef  = loadPrixRef();
  const useApi   = !skipMappingApi && mappingApi.hasCredentials();

  // ── Pré-fetch véhicules (1 appel) pour la consommation théorique ─────────
  const consoMap = {};   // immat → L/100
  if (useApi) {
    try {
      console.log('[carburant-alertes] Récupération véhicules (consommation théorique)…');
      const data = await mappingApi.apiGet('/Vehicles');
      const arr  = mappingApi.toArr(data, 'items', 'results', 'data', 'vehicles');
      for (const v of arr) {
        const reg   = String(v.registrationNumber || v.plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const urban = parseFloat(v.urbanConsumption    || v.fuelConsumptionUrban    || 0);
        const extra = parseFloat(v.extraUrbanConsumption || v.fuelConsumptionExtraUrban || 0);
        const conso = (urban > 0 && extra > 0) ? (urban + extra) / 2
                    : (urban > 0 ? urban : extra > 0 ? extra : 0);
        if (reg && conso > 0) consoMap[reg] = conso;
      }
      console.log(`[carburant-alertes] ${Object.keys(consoMap).length} véhicules avec conso connue.`);
    } catch (e) {
      console.warn(`[carburant-alertes] ⚠ Fetch véhicules : ${e.message} — conso défaut ${CONSO_DEFAUT} L/100 utilisée`);
    }
  }

  // ── Pré-fetch trips par (immat, date) pour Règle B ───────────────────────
  // Groupement pour minimiser les appels API (1 par véhicule×jour)
  const tripCache = {};   // `${immat}::${date}` → trips[]
  if (useApi) {
    const pairs = new Set(
      transactions
        .filter(t => t.immatriculation && t.date)
        .map(t => `${t.immatriculation}::${t.date}`)
    );
    const totalAppels = 1 + pairs.size;  // 1 vehicles + N trips
    const estMin      = Math.ceil(totalAppels * 2.1 / 60);
    console.log(`[carburant-alertes] Règle B : ${pairs.size} paires (véhicule, jour) à fetcher`);
    console.log(`[carburant-alertes] ⏱  ~${totalAppels} appels API Mapping estimés ≈ ${estMin} min`);

    let done = 0;
    for (const key of pairs) {
      const [immat, date] = key.split('::');
      try {
        const data  = await mappingApi.apiGet('/Geolocation/Trips', {
          registrationNumber: immat,
          startDate: `${date}T00:00:00`,
          endDate:   `${date}T23:59:59`,
        });
        tripCache[key] = mappingApi.toArr(data, 'items', 'results', 'data', 'trips', 'journeys');
      } catch (e) {
        console.warn(`[carburant-alertes] ⚠ trips ${immat}/${date} : ${e.message}`);
        tripCache[key] = [];
      }
      done++;
      if (done % 10 === 0) console.log(`[carburant-alertes]   ${done}/${pairs.size} jours fetchés…`);
    }
  }

  // ── Application des 3 règles ─────────────────────────────────────────────
  const results = [];
  for (const t of transactions) {
    const alertes = [];
    const immatNorm = (t.immatriculation || '').replace(/[^A-Z0-9]/g, '');

    // ── Règle A : Écart consommation ──────────────────────────────────────
    if (t._deltaKm !== null && t._deltaKm > 0 && t.litres > 0) {
      const consoRef  = consoMap[immatNorm] || CONSO_DEFAUT;
      const litresTheo = t._deltaKm * consoRef / 100;
      if (litresTheo > 0 && t.litres / litresTheo > 1 + SEUIL_CONSO) {
        const surplusPct = Math.round((t.litres / litresTheo - 1) * 100);
        alertes.push({
          code: 'ECART_CONSO',
          label: 'Écart conso',
          detail: `${t.litres.toFixed(1)} L réel vs ${litresTheo.toFixed(1)} L théorique` +
                  ` (${t._deltaKm} km × ${consoRef} L/100 km) — +${surplusPct}%`,
        });
      }
    }

    // ── Règle B : Transaction hors roulage ────────────────────────────────
    if (useApi && t.immatriculation && t.date) {
      const key   = `${t.immatriculation}::${t.date}`;
      const trips = tripCache[key];
      if (trips !== undefined) {
        const txMs  = new Date(t.datetime).getTime();
        const winMs = 60 * 60 * 1000; // ±1h

        if (trips.length === 0) {
          alertes.push({
            code: 'HORS_ROULAGE',
            label: 'Hors roulage',
            detail: 'Aucun trajet GPS enregistré ce jour',
          });
        } else {
          const covered = trips.some(trip => {
            const s = new Date(trip.startDate || trip.startTime || trip.start || '').getTime();
            const e = new Date(trip.endDate   || trip.endTime   || trip.end   || '').getTime();
            return !isNaN(s) && !isNaN(e) && s <= txMs + winMs && e >= txMs - winMs;
          });
          if (!covered) {
            alertes.push({
              code: 'HORS_ROULAGE',
              label: 'Hors roulage',
              detail: `${trips.length} trajet(s) ce jour — aucun ne couvre ${t.heure} ±1h`,
            });
          }
        }
      }
    }

    // ── Règle C : Prix au litre anormal ───────────────────────────────────
    if (t.montant_ht !== null && t.litres > 0) {
      const prixLitre    = t.montant_ht / t.litres;
      const produitKey   = normProduit(t.produit);
      const prixRefLitre = prixRef[produitKey] || prixRef.defaut || 1.75;
      if (prixLitre > prixRefLitre * (1 + SEUIL_PRIX)) {
        alertes.push({
          code: 'PRIX_ANORMAL',
          label: 'Prix anormal',
          detail: `${prixLitre.toFixed(3)} €/L vs référence ${prixRefLitre} €/L (${produitKey})`,
          prix_litre: Math.round(prixLitre * 1000) / 1000,
        });
      }
    }

    const niveau = alertes.length === 0 ? 'OK'
      : alertes.some(a => a.code === 'HORS_ROULAGE') ? 'CRITIQUE' : 'ATTENTION';

    results.push({ ...t, alertes, niveau });
  }

  // ── Sauvegarde ────────────────────────────────────────────────────────────
  const dataDir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(results, null, 2), 'utf8');

  const nbAlertes = results.filter(r => r.alertes.length > 0).length;
  console.log(`[carburant-alertes] ✓ ${results.length} transactions analysées — ${nbAlertes} avec alertes`);

  return results;
}

function getAlertes() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}

module.exports = { analyserTransactions, getAlertes };
