'use strict';
// Analyse des transactions carburant : 3 règles d'alerte.
// Règle A — Écart consommation théorique
// Règle B — Transaction hors roulage (API Mapping GPS)
// Règle C — Prix au litre anormal
//
// Chaque transaction dans le résultat embarque un objet `diagnostic` avec les
// valeurs calculées pour chaque règle (même non déclenchée), pour affichage
// au clic dans le dashboard.

const fs         = require('fs');
const path       = require('path');
const mappingApi = require('./mapping-api');

const DATA_FILE   = path.join(__dirname, '..', 'data', 'carburant-alertes.json');
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'prix-carburant-reference.json');

const SEUIL_CONSO  = 0.15;  // +15 % sur litres théoriques → ÉCART_CONSO
const SEUIL_PRIX   = 0.15;  // +15 % sur prix référence    → PRIX_ANORMAL
const CONSO_DEFAUT = 28;    // L/100 km si l'API Mapping ne fournit pas de valeur

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

// ── Delta km inter-transactions (Règle A) ─────────────────────────────────────
// Transactions DOIVENT être triées par (immat, datetime) avant l'appel.
function computeDeltaKm(transactions) {
  const prevByImmat = {};
  for (const t of transactions) {
    if (!t.immatriculation) { t._deltaKm = null; continue; }
    const prev = prevByImmat[t.immatriculation];
    if (!prev || t.kilometrage === null) {
      t._deltaKm = null;
    } else {
      const delta = t.kilometrage - prev.km;
      t._deltaKm = delta > 0 ? delta : null;  // km décroissant → ignore (erreur saisie)
    }
    if (t.kilometrage !== null) {
      prevByImmat[t.immatriculation] = { km: t.kilometrage };
    }
  }
}

// ── Analyse principale ────────────────────────────────────────────────────────
async function analyserTransactions(transactions, opts = {}) {
  const { skipMappingApi = false } = opts;

  // ── Diagnostic : log des 5 premières transactions pour vérification ───────
  console.log(`[carburant-alertes] ${transactions.length} transactions à analyser`);
  if (transactions.length) {
    console.log('[carburant-alertes] Aperçu (5 premières) :');
    transactions.slice(0, 5).forEach((t, i) => {
      console.log(
        `  [${i + 1}] immat="${t.immatriculation}" date=${t.date} ` +
        `conducteur="${t.conducteur}" litres=${t.litres} ` +
        `montant=${t.montant_ht} prix_u=${t.prix_unitaire} produit="${t.produit}"`
      );
    });
  }

  // Trim immatriculations (double-sécurité après parser)
  for (const t of transactions) {
    if (t.immatriculation) t.immatriculation = t.immatriculation.trim();
  }

  // Trier par (immat, datetime) pour que le delta km soit correct
  transactions.sort((a, b) =>
    (a.immatriculation || '').localeCompare(b.immatriculation || '') ||
    (a.datetime || '').localeCompare(b.datetime || '')
  );
  computeDeltaKm(transactions);

  const prixRef = loadPrixRef();
  const useApi  = !skipMappingApi && mappingApi.hasCredentials();

  // ── Pré-fetch véhicules (1 appel) : consommation théorique pour Règle A ──
  const consoMap = {};
  if (useApi) {
    try {
      console.log('[carburant-alertes] Récupération véhicules (consommation théorique)…');
      const data = await mappingApi.apiGet('/Vehicles');
      const arr  = mappingApi.toArr(data, 'items', 'results', 'data', 'vehicles');
      for (const v of arr) {
        const reg   = String(v.registrationNumber || v.plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const urban = parseFloat(v.urbanConsumption       || v.fuelConsumptionUrban       || 0);
        const extra = parseFloat(v.extraUrbanConsumption  || v.fuelConsumptionExtraUrban  || 0);
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
  // Séparation trips réussis / erreurs pour ne pas créer de fausses alertes.
  const tripCache  = {};  // key `${immat}::${date}` → trips[] (succès API)
  const tripErrors = {};  // key `${immat}::${date}` → message d'erreur
  if (useApi) {
    const pairs = new Set(
      transactions
        .filter(t => t.immatriculation && t.date)
        .map(t => `${t.immatriculation}::${t.date}`)
    );
    const totalAppels = 1 + pairs.size;
    const estMin      = Math.ceil(totalAppels * 2.1 / 60);
    console.log(`[carburant-alertes] Règle B : ${pairs.size} paires (véhicule, jour) à fetcher`);
    console.log(`[carburant-alertes] ⏱  ~${totalAppels} appels API Mapping estimés ≈ ${estMin} min`);

    let done = 0;
    for (const key of pairs) {
      const [immat, date] = key.split('::');
      try {
        const data = await mappingApi.apiGet('/Geolocation/Trips', {
          registrationNumber: immat,
          startDate: `${date}T00:00:00`,
          endDate:   `${date}T23:59:59`,
        });
        tripCache[key] = mappingApi.toArr(data, 'items', 'results', 'data', 'trips', 'journeys');
      } catch (e) {
        console.warn(`[carburant-alertes] ⚠ trips ${immat}/${date} : ${e.message}`);
        tripErrors[key] = e.message;  // NE PAS mettre [] ici → fausse alerte hors roulage
      }
      done++;
      if (done % 10 === 0) console.log(`[carburant-alertes]   ${done}/${pairs.size} jours fetchés…`);
    }
  }

  // ── Application des 3 règles ─────────────────────────────────────────────
  const results = [];

  for (const t of transactions) {
    const alertes   = [];
    const immatNorm = (t.immatriculation || '').replace(/[^A-Z0-9]/g, '');
    const diagA     = buildDiagA(t, consoMap, immatNorm, alertes);
    const diagB     = buildDiagB(t, useApi, tripCache, tripErrors, alertes);
    const diagC     = buildDiagC(t, prixRef, alertes);

    const niveau = alertes.length === 0 ? 'OK'
      : alertes.some(a => a.code === 'HORS_ROULAGE') ? 'CRITIQUE' : 'ATTENTION';

    results.push({
      ...t,
      alertes,
      niveau,
      diagnostic: { ecart_conso: diagA, hors_roulage: diagB, prix_anormal: diagC },
    });
  }

  // ── Sauvegarde ────────────────────────────────────────────────────────────
  const dataDir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(results, null, 2), 'utf8');

  const nbAlertes = results.filter(r => r.alertes.length > 0).length;
  console.log(`[carburant-alertes] ✓ ${results.length} transactions analysées — ${nbAlertes} avec alertes`);

  return results;
}

// ── Règle A : écart consommation ─────────────────────────────────────────────
function buildDiagA(t, consoMap, immatNorm, alertes) {
  const SEUIL_PCT = Math.round(SEUIL_CONSO * 100);

  if (t._deltaKm === null || t._deltaKm <= 0 || !(t.litres > 0)) {
    const raison = t._deltaKm === null   ? 'Pas de km précédent disponible (première transaction de ce véhicule)'
      : t._deltaKm <= 0                  ? 'Kilométrage décroissant ou identique — ignoré'
      : 'Litres = 0';
    return {
      declenche: null,
      raison_non_evalue: raison,
      km_parcourus:      t._deltaKm,
      conso_ref:         null,
      litres_theoriques: null,
      litres_reels:      t.litres,
      seuil_pct:         SEUIL_PCT,
    };
  }

  const consoRef    = consoMap[immatNorm] || CONSO_DEFAUT;
  const litresTheo  = Math.round(t._deltaKm * consoRef / 100 * 10) / 10;
  const ratio       = litresTheo > 0 ? t.litres / litresTheo : null;
  const declenche   = ratio !== null && ratio > 1 + SEUIL_CONSO;

  if (declenche) {
    const surplusPct = Math.round((ratio - 1) * 100);
    alertes.push({
      code:   'ECART_CONSO',
      label:  'Écart conso',
      detail: `${t.litres.toFixed(1)} L réel vs ${litresTheo.toFixed(1)} L théorique` +
              ` (${t._deltaKm} km × ${consoRef} L/100 km) — +${surplusPct}%`,
    });
  }

  return {
    declenche,
    raison_non_evalue: null,
    km_parcourus:      t._deltaKm,
    conso_ref:         consoRef,
    litres_theoriques: litresTheo,
    litres_reels:      t.litres,
    seuil_pct:         SEUIL_PCT,
  };
}

// ── Règle B : hors roulage GPS ───────────────────────────────────────────────
function buildDiagB(t, useApi, tripCache, tripErrors, alertes) {
  if (!useApi || !t.immatriculation || !t.date) {
    const raison = !useApi                ? 'API Mapping non configurée (skipMapping ou credentials manquants)'
      : !t.immatriculation                ? 'Immatriculation manquante'
      : 'Date manquante';
    return { declenche: null, raison_non_evalue: raison, trajets_trouves: null, erreur_api: null, heure_transaction: t.heure || null };
  }

  const key    = `${t.immatriculation}::${t.date}`;
  const erreur = tripErrors[key];

  // Erreur API → ne PAS déclencher l'alerte, signaler clairement
  if (erreur) {
    return { declenche: null, raison_non_evalue: null, trajets_trouves: null, erreur_api: erreur, heure_transaction: t.heure || null };
  }

  const trips = tripCache[key];
  if (trips === undefined) {
    // Ne devrait pas arriver (la paire était dans le Set), mais par sécurité
    return { declenche: null, raison_non_evalue: 'Données API non disponibles', trajets_trouves: null, erreur_api: null, heure_transaction: t.heure || null };
  }

  const txMs  = new Date(t.datetime).getTime();
  const winMs = 60 * 60 * 1000; // ±1h

  if (trips.length === 0) {
    alertes.push({ code: 'HORS_ROULAGE', label: 'Hors roulage', detail: 'Aucun trajet GPS enregistré ce jour' });
    return { declenche: true, raison_non_evalue: null, trajets_trouves: 0, erreur_api: null, heure_transaction: t.heure || null };
  }

  const covered = trips.some(trip => {
    const s = new Date(trip.startDate || trip.startTime || trip.start || '').getTime();
    const e = new Date(trip.endDate   || trip.endTime   || trip.end   || '').getTime();
    return !isNaN(s) && !isNaN(e) && s <= txMs + winMs && e >= txMs - winMs;
  });

  if (!covered) {
    alertes.push({
      code:   'HORS_ROULAGE',
      label:  'Hors roulage',
      detail: `${trips.length} trajet(s) ce jour — aucun ne couvre ${t.heure} ±1h`,
    });
  }
  return { declenche: !covered, raison_non_evalue: null, trajets_trouves: trips.length, erreur_api: null, heure_transaction: t.heure || null };
}

// ── Règle C : prix au litre anormal ──────────────────────────────────────────
function buildDiagC(t, prixRef, alertes) {
  const SEUIL_PCT = Math.round(SEUIL_PRIX * 100);

  if (!(t.litres > 0)) {
    return { declenche: null, raison_non_evalue: 'Litres = 0', prix_reel: null, prix_source: null, prix_reference: null, produit: normProduit(t.produit), seuil_pct: SEUIL_PCT };
  }

  let prixLitre = null;
  let prixSource = null;
  if (t.prix_unitaire != null) {
    prixLitre  = t.prix_unitaire;
    prixSource = 'colonne fichier';
  } else if (t.montant_ht != null) {
    prixLitre  = t.montant_ht / t.litres;
    prixSource = 'calcul montant/litres';
  }

  if (prixLitre === null) {
    return { declenche: null, raison_non_evalue: 'Prix unitaire et montant HT non disponibles', prix_reel: null, prix_source: null, prix_reference: null, produit: normProduit(t.produit), seuil_pct: SEUIL_PCT };
  }

  const produitKey   = normProduit(t.produit);
  const prixRefLitre = prixRef[produitKey] || prixRef.defaut || 1.75;
  const declenche    = prixLitre > prixRefLitre * (1 + SEUIL_PRIX);
  const prixReel     = Math.round(prixLitre * 1000) / 1000;

  if (declenche) {
    alertes.push({
      code:      'PRIX_ANORMAL',
      label:     'Prix anormal',
      detail:    `${prixReel.toFixed(3)} €/L vs référence ${prixRefLitre} €/L (${produitKey})`,
      prix_litre: prixReel,
    });
  }

  return {
    declenche,
    raison_non_evalue: null,
    prix_reel:         prixReel,
    prix_source:       prixSource,
    prix_reference:    prixRefLitre,
    produit:           produitKey,
    seuil_pct:         SEUIL_PCT,
  };
}

// ── Lecture résultats sauvegardés ─────────────────────────────────────────────
function getAlertes() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}

module.exports = { analyserTransactions, getAlertes };
