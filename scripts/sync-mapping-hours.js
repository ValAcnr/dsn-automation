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

// ── Scan d'une journée ───────────────────────────────────────────────────────
// Retourne { dayPayload, scanned, errors }
async function syncDay(fetch, headers, active, targetDate) {
  const startDate = targetDate.toISOString().replace(/\.\d{3}Z$/, '');
  const endDate   = new Date(targetDate.getTime() + 24 * 3600 * 1000)
                      .toISOString().replace(/\.\d{3}Z$/, '');

  const driverTotals = {};
  let scanned = 0;
  let errors  = 0;

  for (const v of active) {
    const reg = v.registrationNumber || v.plate || v.immatriculation || String(v.id || '');
    if (!reg) continue;

    scanned++;
    if (scanned % 50 === 0) {
      console.log(`[sync-mapping]   ${scanned}/${active.length} véhicules scannés…`);
    }

    const url = `${BASE_API}/Geolocation/Trips`
      + `?startDate=${startDate}&endDate=${endDate}&registrationNumber=${encodeURIComponent(reg)}`;

    try {
      const data  = await apiGet(fetch, url, headers);
      const trips = toArr(data, 'items', 'results', 'data', 'trips', 'journeys');

      for (const trip of trips) {
        const driver = trip.driver;
        if (!driver) continue;

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
        if (driverName && driverName !== driverId) {
          driverTotals[driverId].driverName = driverName;
        }
      }
    } catch (e) {
      errors++;
      if (errors <= 5) {
        console.warn(`[sync-mapping]   ⚠️  ${reg} : ${e.message}`);
      }
    }

    await sleep(RATE_LIMIT_DELAY_MS);
  }

  const dayPayload = {};
  for (const [driverId, d] of Object.entries(driverTotals)) {
    dayPayload[driverId] = {
      driverName:   d.driverName,
      totalSeconds: d.totalSeconds,
      totalHours:   Math.round(d.totalSeconds / 36) / 100,
      trips:        d.trips,
    };
  }

  return { dayPayload, scanned, errors };
}

// ── Parsing des arguments --from / --to ─────────────────────────────────────
function parseArgs() {
  let from = null;
  let to   = null;
  for (const arg of process.argv.slice(2)) {
    const mFrom = arg.match(/^--from=(\d{4}-\d{2}-\d{2})$/);
    const mTo   = arg.match(/^--to=(\d{4}-\d{2}-\d{2})$/);
    if (mFrom) from = mFrom[1];
    if (mTo)   to   = mTo[1];
  }
  return { from, to };
}

// Génère une liste de dates YYYY-MM-DD entre start et end inclus
function dateRange(fromStr, toStr) {
  const dates = [];
  const cur   = new Date(fromStr + 'T00:00:00Z');
  const end   = new Date(toStr   + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(new Date(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// ── Point d'entrée ───────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  const { default: fetch } = await import('node-fetch');

  const args = parseArgs();

  // Construction de la liste de dates à traiter
  let dates;
  if (args.from && args.to) {
    dates = dateRange(args.from, args.to);
    if (dates.length === 0) {
      console.error('❌ --from est postérieur à --to');
      process.exit(1);
    }
  } else if (args.from) {
    dates = dateRange(args.from, args.from);
  } else {
    // Comportement par défaut : hier
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    yesterday.setUTCHours(0, 0, 0, 0);
    dates = [yesterday];
  }

  const dateKeys = dates.map(d => d.toISOString().split('T')[0]);

  // ── Auth ─────────────────────────────────────────────────────────────────
  console.log('[sync-mapping] Authentification…');
  const token   = await getToken(fetch);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  console.log('[sync-mapping] Token obtenu.');

  // ── Véhicules actifs (récupérés une seule fois) ───────────────────────────
  console.log('[sync-mapping] Récupération des véhicules…');
  const vehiclesData = await apiGet(fetch, `${BASE_API}/Vehicles`, headers);
  const allVehicles  = toArr(vehiclesData, 'items', 'results', 'data', 'vehicles');
  const active = allVehicles.filter(v => {
    const st = (v.status || v.fleetStatus || v.vehicleStatus || '').toString().toUpperCase();
    return st !== 'OUT_FLEET' && st !== 'OUT OF FLEET';
  });
  console.log(`[sync-mapping] ${allVehicles.length} véhicules au total, ${active.length} actifs.`);

  const estMinPerDay = Math.ceil(active.length * RATE_LIMIT_DELAY_MS / 60000);
  if (dates.length > 1) {
    const estTotal = dates.length * estMinPerDay;
    const estH     = Math.floor(estTotal / 60);
    const estM     = estTotal % 60;
    console.log(`\n[sync-mapping] 📅 Plage : ${dateKeys[0]} → ${dateKeys[dateKeys.length - 1]} (${dates.length} jour(s))`);
    console.log(`[sync-mapping] ⏱  Durée estimée : ${dates.length} × ~${estMinPerDay} min ≈ ${estH > 0 ? estH + ' h ' : ''}${estM} min`);
    console.log('[sync-mapping] Démarrage du traitement…\n');
  } else {
    console.log(`[sync-mapping] Date cible : ${dateKeys[0]}`);
    console.log(`[sync-mapping] Durée estimée : ~${estMinPerDay} min (rate limit 30 req/min)\n`);
  }

  // ── Traitement jour par jour ──────────────────────────────────────────────
  const globalDrivers = new Set();  // conducteurs uniques sur toute la plage
  const dailyResults  = [];

  for (let i = 0; i < dates.length; i++) {
    const targetDate = dates[i];
    const dateKey    = dateKeys[i];
    const tDay       = Date.now();

    if (dates.length > 1) {
      console.log(`\n── Jour ${i + 1}/${dates.length} : ${dateKey} ────────────────────`);
    }

    const { dayPayload, scanned, errors } = await syncDay(fetch, headers, active, targetDate);

    // Fusion dans le fichier JSON
    let existing = {};
    if (fs.existsSync(DATA_FILE)) {
      try { existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { /* repart de zéro */ }
    }
    existing[dateKey] = dayPayload;
    const dataDir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2), 'utf8');

    const nbDrivers = Object.keys(dayPayload).length;
    const totalH    = Object.values(dayPayload).reduce((s, d) => s + d.totalSeconds, 0);
    const elapsed   = ((Date.now() - tDay) / 1000).toFixed(1);

    for (const id of Object.keys(dayPayload)) globalDrivers.add(id);
    dailyResults.push({ dateKey, scanned, errors, nbDrivers, totalH });

    // Résumé du jour
    console.log(`\n══════════════════════════════════════════════`);
    console.log(`  Résumé sync ${dateKey}`);
    console.log(`══════════════════════════════════════════════`);
    console.log(`  Véhicules scannés  : ${scanned} (${errors} erreur(s))`);
    console.log(`  Conducteurs        : ${nbDrivers}`);
    console.log(`  Total heures GPS   : ${(totalH / 3600).toFixed(2)} h`);
    console.log(`  Durée d'exécution  : ${elapsed} s`);
    console.log(`══════════════════════════════════════════════`);

    if (nbDrivers > 0) {
      console.log('Détail par conducteur :');
      Object.entries(dayPayload)
        .sort((a, b) => b[1].totalSeconds - a[1].totalSeconds)
        .forEach(([id, d]) => {
          console.log(`  ${id.padEnd(14)}  ${d.driverName.padEnd(25)}  ${String(d.totalHours).padStart(6)} h  (${d.trips} trajet(s))`);
        });
    }
  }

  // ── Résumé global (multi-jours uniquement) ────────────────────────────────
  if (dates.length > 1) {
    const totalElapsed  = ((Date.now() - t0) / 1000 / 60).toFixed(1);
    const totalErrors   = dailyResults.reduce((s, r) => s + r.errors, 0);
    const totalGpsH     = dailyResults.reduce((s, r) => s + r.totalH, 0);

    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║  Résumé global de la synchronisation          ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log(`  Plage traitée       : ${dateKeys[0]} → ${dateKeys[dateKeys.length - 1]}`);
    console.log(`  Jours traités       : ${dates.length}`);
    console.log(`  Conducteurs uniques : ${globalDrivers.size}`);
    console.log(`  Total heures GPS    : ${(totalGpsH / 3600).toFixed(2)} h`);
    console.log(`  Erreurs totales     : ${totalErrors}`);
    console.log(`  Durée totale        : ${totalElapsed} min`);
    console.log(`  Fichier mis à jour  : ${DATA_FILE}`);
    console.log('════════════════════════════════════════════════\n');
  } else {
    console.log(`\n  Fichier mis à jour : ${DATA_FILE}`);
    console.log(`  Durée totale       : ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
  }
}

main().catch(e => {
  console.error('\n❌ Erreur fatale :', e.message);
  process.exit(1);
});
