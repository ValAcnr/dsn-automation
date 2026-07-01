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

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ MAPPING_CLIENT_ID / MAPPING_CLIENT_SECRET manquants dans .env');
  process.exit(1);
}

// ── Endpoints token à tester (IdentityServer4 preprod) ─────────────────────
const TOKEN_CANDIDATES = [
  'https://identityserver-preprod.optimum-automotive.com/connect/token',
  'https://identityserver-preprod.optimum-automotive.com/oauth2/token',
  'https://identityserver-preprod.optimum-automotive.com/oauth/token',
  'https://identityserver-preprod.optimum-automotive.com/token',
  `${BASE_API}/connect/token`,
  `${BASE_API}/oauth2/token`,
  `${BASE_API}/token`,
];

// ── Endpoints véhicules à tester ────────────────────────────────────────────
const VEHICLE_CANDIDATES = [
  '/api/v1/vehicles',
  '/api/v2/vehicles',
  '/api/v3/vehicles',
  '/api/vehicles',
  '/v1/vehicles',
  '/vehicles',
  '/api/v1/assets',
  '/api/assets',
  '/api/v1/fleets',
];

// ── Endpoints trajets à tester ───────────────────────────────────────────────
function tripCandidates(vehicleId) {
  const today    = new Date().toISOString().split('T')[0];
  const weekAgo  = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  const perVehicle = vehicleId ? [
    `/api/v1/vehicles/${vehicleId}/trips?from=${weekAgo}&to=${today}`,
    `/api/v1/vehicles/${vehicleId}/trips?startDate=${weekAgo}&endDate=${today}`,
    `/api/v1/vehicles/${vehicleId}/driving-time?from=${weekAgo}&to=${today}`,
    `/api/v1/vehicles/${vehicleId}/journeys?from=${weekAgo}&to=${today}`,
    `/api/v2/vehicles/${vehicleId}/trips?from=${weekAgo}&to=${today}`,
  ] : [];

  return [
    ...perVehicle,
    `/api/v1/trips?from=${weekAgo}&to=${today}`,
    `/api/v2/trips?from=${weekAgo}&to=${today}`,
    `/api/trips?from=${weekAgo}&to=${today}`,
    `/api/v1/trips?startDate=${weekAgo}&endDate=${today}`,
    `/api/v1/driving-time?from=${weekAgo}&to=${today}`,
    `/api/v1/journeys?from=${weekAgo}&to=${today}`,
    `/v1/trips?from=${weekAgo}&to=${today}`,
    `/api/v1/trips?from=${monthAgo}&to=${today}`,
  ];
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function sep(title) {
  console.log('\n' + '═'.repeat(60));
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

async function tryGet(fetch, url, headers) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    const raw = await r.text();
    return { ok: r.ok, status: r.status, raw };
  } catch (e) {
    return { ok: false, status: 0, raw: '', err: e.message };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const { default: fetch } = await import('node-fetch');

  console.log('DSN TRANSPORTS — Exploration API Mapping Control (Optimum Automotive)');
  console.log(`CLIENT_ID : ${CLIENT_ID}`);
  console.log(`BASE_API  : ${BASE_API}\n`);

  // 1. Obtenir le token OAuth2 ───────────────────────────────────────────────
  sep('1. AUTHENTIFICATION OAuth2 client_credentials');

  let token = null;

  for (const url of TOKEN_CANDIDATES) {
    process.stdout.write(`[AUTH] ${url} → `);
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
      const raw = await r.text();
      console.log(`HTTP ${r.status}  ${raw.slice(0, 180)}`);
      if (r.ok) {
        const j = JSON.parse(raw);
        token = j.access_token;
        console.log(`\n✅ Token obtenu — type:${j.token_type}  expires_in:${j.expires_in}s  scope:${j.scope || '(none)'}`);
        break;
      }
    } catch (e) {
      console.log(`ERREUR réseau : ${e.message}`);
    }
  }

  if (!token) {
    console.error('\n❌ Aucun token obtenu. Arrêt.');
    process.exit(1);
  }

  const authHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  // 2. Swagger — découverte des endpoints ───────────────────────────────────
  sep('2. SWAGGER / OPENAPI — découverte des endpoints');

  const swaggerCandidates = [
    `${BASE_API}/swagger/v1/swagger.json`,
    `${BASE_API}/swagger/v2/swagger.json`,
    `${BASE_API}/swagger/v3/swagger.json`,
    `${BASE_API}/api/swagger.json`,
    `${BASE_API}/openapi.json`,
    `${BASE_API}/openapi/v1/openapi.json`,
  ];

  for (const url of swaggerCandidates) {
    process.stdout.write(`[SWAGGER] ${url} → `);
    const { ok, status, raw, err } = await tryGet(fetch, url, authHeaders);
    if (err) { console.log(`ERREUR : ${err}`); continue; }
    console.log(`HTTP ${status}`);
    if (ok) {
      try {
        const spec = JSON.parse(raw);
        const paths = Object.keys(spec.paths || {}).sort();
        console.log(`✅ ${paths.length} paths trouvés :`);
        paths.forEach(p => {
          const methods = Object.keys(spec.paths[p]).join(', ').toUpperCase();
          console.log(`   [${methods}] ${p}`);
        });
      } catch {
        console.log(`   Contenu non-JSON (${raw.length} chars) : ${raw.slice(0, 200)}`);
      }
      break;
    }
  }

  // 3. Endpoints véhicules ────────────────────────────────────────────────────
  sep('3. LISTE DES VÉHICULES');

  let vehicleId = null;

  for (const ep of VEHICLE_CANDIDATES) {
    const url = `${BASE_API}${ep}`;
    process.stdout.write(`[VEHICLES] GET ${url} → `);
    const { ok, status, raw, err } = await tryGet(fetch, url, authHeaders);
    if (err) { console.log(`ERREUR : ${err}`); continue; }
    console.log(`HTTP ${status}`);
    if (ok) {
      try {
        const data = JSON.parse(raw);
        const arr  = Array.isArray(data) ? data : (data.items || data.results || data.data || data.vehicles || [data]);
        console.log(`\n✅ Véhicules à ${ep} — ${arr.length} entrées`);
        if (arr.length > 0) {
          const first = arr[0];
          vehicleId = first.id ?? first.vehicleId ?? first.identifier ?? first.immatriculation ?? null;
          console.log(`\n--- Premier véhicule (tous champs) ---`);
          console.log(JSON.stringify(first, null, 2));
          if (arr.length > 1) {
            console.log(`\n--- Deuxième véhicule ---`);
            console.log(JSON.stringify(arr[1], null, 2));
          }
        } else {
          console.log('--- Réponse complète ---');
          console.log(JSON.stringify(data, null, 2));
        }
        console.log(`\n   → vehicleId retenu pour les trajets : ${vehicleId}`);
      } catch {
        console.log(`   Réponse brute : ${raw.slice(0, 400)}`);
      }
      break;
    } else {
      console.log(`   ${raw.slice(0, 200)}`);
    }
  }

  // 4. Endpoints trajets ─────────────────────────────────────────────────────
  sep('4. TRAJETS / CONDUITE');

  for (const ep of tripCandidates(vehicleId)) {
    const url = `${BASE_API}${ep}`;
    process.stdout.write(`[TRIPS] GET ${url} → `);
    const { ok, status, raw, err } = await tryGet(fetch, url, authHeaders);
    if (err) { console.log(`ERREUR : ${err}`); continue; }
    console.log(`HTTP ${status}`);
    if (ok) {
      try {
        const data = JSON.parse(raw);
        const arr  = Array.isArray(data) ? data : (data.items || data.results || data.data || data.trips || data.journeys || []);
        console.log(`\n✅ Trajets à ${ep} — ${arr.length} entrée(s)`);
        if (arr.length > 0) {
          console.log('\n--- Premier trajet (tous champs) ---');
          console.log(JSON.stringify(arr[0], null, 2));
        } else {
          console.log('--- Réponse complète (vide ou structure différente) ---');
          console.log(JSON.stringify(data, null, 2));
        }
        console.log('\n--- Champs clés présents ? ---');
        const sample = arr[0] || data;
        const keys   = sample ? Object.keys(sample) : [];
        console.log(`   Champs disponibles : ${keys.join(', ')}`);
        ['driver', 'conducteur', 'driverId', 'driverName', 'userId',
         'duration', 'drivingTime', 'amplitude', 'distance', 'km',
         'startDate', 'endDate', 'date', 'vehicle', 'vehicleId', 'plate']
          .forEach(k => {
            const found = keys.find(key => key.toLowerCase().includes(k.toLowerCase()));
            if (found) console.log(`   ✓ "${found}" = ${JSON.stringify(sample[found])}`);
          });
      } catch {
        console.log(`   Réponse brute : ${raw.slice(0, 400)}`);
      }
      break;
    } else {
      console.log(`   ${raw.slice(0, 200)}`);
    }
  }

  sep('FIN EXPLORATION');
}

main().catch(e => {
  console.error('\n❌ Erreur fatale :', e.message);
  process.exit(1);
});
