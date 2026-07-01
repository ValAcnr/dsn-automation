'use strict';

const fs   = require('fs');
const path = require('path');

// ── Chargement .env ──────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq === -1 || line.trimStart().startsWith('#')) return;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key) process.env[key] = val;
  });
}

const CLIENT_ID     = process.env.MAPPING_CLIENT_ID;
const CLIENT_SECRET = process.env.MAPPING_CLIENT_SECRET;
const BASE_API      = 'https://apicore-preprod.optimum-automotive.com';
const DATA_FILE     = path.join(__dirname, '..', 'data', 'gps-hours.json');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ MAPPING_CLIENT_ID / MAPPING_CLIENT_SECRET manquants dans .env');
  process.exit(1);
}

const TOKEN_CANDIDATES = [
  'https://identityserver-preprod.optimum-automotive.com/connect/token',
  'https://identityserver-preprod.optimum-automotive.com/oauth2/token',
  'https://identityserver-preprod.optimum-automotive.com/oauth/token',
  'https://identityserver-preprod.optimum-automotive.com/token',
  `${BASE_API}/connect/token`,
  `${BASE_API}/oauth2/token`,
  `${BASE_API}/token`,
];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getToken(fetch) {
  for (const url of TOKEN_CANDIDATES) {
    try {
      const body = new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
      });
      const r = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) {
        const j = await r.json();
        return j.access_token;
      }
    } catch { /* essaie le suivant */ }
  }
  throw new Error('Impossible d\'obtenir un token OAuth2');
}

const RATE_LIMIT_DELAY_MS = 2100;   // 30 req/min → 1 req/2 s, +100 ms de marge
const RETRY_429_DELAY_MS  = 65000;  // attente après 429 (fenêtre 1 min + marge)

async function apiGet(fetch, url, headers) {
  const doFetch = () => fetch(url, { headers, signal: AbortSignal.timeout(15000) });

  let r = await doFetch();

  if (r.status === 429) {
    console.warn(`[sync-mapping] ⏳ 429 Rate Limit sur ${url.split('?')[0]} — attente ${RETRY_429_DELAY_MS / 1000} s…`);
    await sleep(RETRY_429_DELAY_MS);
    r = await doFetch();
    if (r.status === 429) {
      throw new Error(`HTTP 429 persistant après retry : ${url}`);
    }
  }

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`HTTP ${r.status} ${url} — ${body.slice(0, 200)}`);
  }
  return r.json();
}

function toArr(data, ...keys) {
  if (Array.isArray(data)) return data;
  for (const k of keys) if (Array.isArray(data[k])) return data[k];
  return [data];
}

async function main() {
  const t0 = Date.now();
  const { default: fetch } = await import('node-fetch');

  // ── Date cible : hier ────────────────────────────────────────────────────
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  const dateKey   = yesterday.toISOString().split('T')[0];               // "2026-06-30"
  const startDate = yesterday.toISOString().replace(/\.\d{3}Z$/, '');    // sans ms
  const endDate   = new Date(yesterday.getTime() + 24 * 3600 * 1000)
                      .toISOString().replace(/\.\d{3}Z$/, '');

  console.log(`[sync-mapping] Date cible : ${dateKey}  (${startDate} → ${endDate})`);

  // ── Auth ─────────────────────────────────────────────────────────────────
  console.log('[sync-mapping] Authentification…');
  const token = await getToken(fetch);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  console.log('[sync-mapping] Token obtenu.');

  // ── Véhicules actifs ─────────────────────────────────────────────────────
  console.log('[sync-mapping] Récupération des véhicules…');
  const vehiclesData = await apiGet(fetch, `${BASE_API}/Vehicles`, headers);
  const allVehicles  = toArr(vehiclesData, 'items', 'results', 'data', 'vehicles');
  const active = allVehicles.filter(v => {
    const st = (v.status || v.fleetStatus || v.vehicleStatus || '').toString().toUpperCase();
    return st !== 'OUT_FLEET' && st !== 'OUT OF FLEET';
  });
  console.log(`[sync-mapping] ${allVehicles.length} véhicules au total, ${active.length} actifs.`);
  const estMinutes = Math.ceil(active.length * RATE_LIMIT_DELAY_MS / 60000);
  console.log(`[sync-mapping] Durée estimée : ${active.length} × ${RATE_LIMIT_DELAY_MS / 1000} s ≈ ${estMinutes} min (rate limit 30 req/min)`);

  // ── Trajets par véhicule ─────────────────────────────────────────────────
  // Accumule : { driverRegistrationNumber → { driverName, totalSeconds, trips } }
  const driverTotals = {};

  let scanned = 0;
  let errors  = 0;

  for (const v of active) {
    const reg = v.registrationNumber || v.plate || v.immatriculation || String(v.id || '');
    if (!reg) continue;

    scanned++;
    if (scanned % 50 === 0) {
      console.log(`[sync-mapping] ${scanned}/${active.length} véhicules scannés…`);
    }

    const url = `${BASE_API}/Geolocation/Trips`
      + `?startDate=${startDate}&endDate=${endDate}&registrationNumber=${encodeURIComponent(reg)}`;

    try {
      const data  = await apiGet(fetch, url, headers);
      const trips = toArr(data, 'items', 'results', 'data', 'trips', 'journeys');

      for (const trip of trips) {
        const driver = trip.driver;
        if (!driver) continue;

        // Identifiant conducteur (registrationNumber ou id selon l'API)
        const driverId = (driver.registrationNumber || driver.id || driver.driverId || '').toString().trim();
        if (!driverId) continue;

        const driverName = [driver.firstName, driver.lastName]
          .filter(Boolean).join(' ').trim()
          || driver.name || driver.fullName || driverId;

        const seconds = typeof trip.duration === 'number'
          ? trip.duration
          : typeof trip.drivingTime === 'number'
            ? trip.drivingTime
            : 0;

        if (!driverTotals[driverId]) {
          driverTotals[driverId] = { driverName, totalSeconds: 0, trips: 0 };
        }
        driverTotals[driverId].totalSeconds += seconds;
        driverTotals[driverId].trips        += 1;
        // Garde le nom le plus récent (au cas où il varie)
        if (driverName && driverName !== driverId) {
          driverTotals[driverId].driverName = driverName;
        }
      }
    } catch (e) {
      errors++;
      if (errors <= 5) {
        console.warn(`[sync-mapping] ⚠️  ${reg} : ${e.message}`);
      }
    }

    await sleep(RATE_LIMIT_DELAY_MS);
  }

  // ── Construction du payload de la journée ────────────────────────────────
  const dayPayload = {};
  for (const [driverId, d] of Object.entries(driverTotals)) {
    dayPayload[driverId] = {
      driverName:   d.driverName,
      totalSeconds: d.totalSeconds,
      totalHours:   Math.round(d.totalSeconds / 36) / 100,  // 2 décimales
      trips:        d.trips,
    };
  }

  // ── Fusion avec le fichier existant ──────────────────────────────────────
  let existing = {};
  if (fs.existsSync(DATA_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { /* repart de zéro */ }
  }

  existing[dateKey] = dayPayload;

  const dataDir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2), 'utf8');

  // ── Résumé ────────────────────────────────────────────────────────────────
  const elapsed   = ((Date.now() - t0) / 1000).toFixed(1);
  const nbDrivers = Object.keys(dayPayload).length;
  const totalH    = Object.values(dayPayload)
    .reduce((s, d) => s + d.totalSeconds, 0);

  console.log('\n══════════════════════════════════════════════');
  console.log(`  Résumé sync ${dateKey}`);
  console.log('══════════════════════════════════════════════');
  console.log(`  Véhicules scannés  : ${scanned} (${errors} erreur(s))`);
  console.log(`  Conducteurs        : ${nbDrivers}`);
  console.log(`  Total heures GPS   : ${(totalH / 3600).toFixed(2)} h`);
  console.log(`  Durée d'exécution  : ${elapsed} s`);
  console.log(`  Fichier mis à jour : ${DATA_FILE}`);
  console.log('══════════════════════════════════════════════\n');

  if (nbDrivers > 0) {
    console.log('Détail par conducteur :');
    Object.entries(dayPayload)
      .sort((a, b) => b[1].totalSeconds - a[1].totalSeconds)
      .forEach(([id, d]) => {
        console.log(`  ${id.padEnd(14)}  ${d.driverName.padEnd(25)}  ${String(d.totalHours).padStart(6)} h  (${d.trips} trajet(s))`);
      });
  }
}

main().catch(e => {
  console.error('\n❌ Erreur fatale :', e.message);
  process.exit(1);
});
