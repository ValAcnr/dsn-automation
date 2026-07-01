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

// Véhicule cible pour les tests unitaires
const REG = 'EW-266-YQ';

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

// ── Helpers ──────────────────────────────────────────────────────────────────
function sep(title) {
  console.log('\n' + '═'.repeat(60));
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

async function tryGet(fetch, url, headers) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const raw = await r.text();
    return { ok: r.ok, status: r.status, raw };
  } catch (e) {
    return { ok: false, status: 0, raw: '', err: e.message };
  }
}

function printKeyFields(sample) {
  if (!sample || typeof sample !== 'object') return;
  const keys = Object.keys(sample);
  console.log(`\n   Tous les champs : ${keys.join(', ')}`);
  ['driver', 'conducteur', 'driverId', 'driverName', 'driverIdentificationNumber',
   'personId', 'userId', 'identificationNumber',
   'duration', 'drivingTime', 'amplitude', 'distance', 'km',
   'startDate', 'endDate', 'date', 'vehicle', 'vehicleId',
   'registrationNumber', 'plate', 'immatriculation', 'currentDriver']
    .forEach(k => {
      const found = keys.find(key => key.toLowerCase().includes(k.toLowerCase()));
      if (found) console.log(`   ✓ "${found}" = ${JSON.stringify(sample[found])}`);
    });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const { default: fetch } = await import('node-fetch');

  console.log('DSN TRANSPORTS — Exploration API Mapping Control (Optimum Automotive)');
  console.log(`CLIENT_ID : ${CLIENT_ID}`);
  console.log(`BASE_API  : ${BASE_API}`);
  console.log(`Véhicule cible : ${REG}\n`);

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

  // 2. Swagger — sauvegarde complète dans mapping-swagger.json ──────────────
  sep('2. SWAGGER / OPENAPI — découverte et sauvegarde');

  const swaggerCandidates = [
    `${BASE_API}/swagger/v1/swagger.json`,
    `${BASE_API}/swagger/v2/swagger.json`,
    `${BASE_API}/swagger/v3/swagger.json`,
    `${BASE_API}/api/swagger.json`,
    `${BASE_API}/openapi.json`,
    `${BASE_API}/openapi/v1/openapi.json`,
  ];

  const swaggerOut = path.join(__dirname, 'mapping-swagger.json');
  let swaggerSpec  = null;

  for (const url of swaggerCandidates) {
    process.stdout.write(`[SWAGGER] ${url} → `);
    const { ok, status, raw, err } = await tryGet(fetch, url, authHeaders);
    if (err) { console.log(`ERREUR : ${err}`); continue; }
    console.log(`HTTP ${status}`);
    if (ok) {
      try {
        swaggerSpec = JSON.parse(raw);
        fs.writeFileSync(swaggerOut, JSON.stringify(swaggerSpec, null, 2), 'utf8');
        console.log(`✅ Swagger sauvegardé → ${swaggerOut}`);
        const paths = Object.keys(swaggerSpec.paths || {}).sort();
        console.log(`   ${paths.length} paths disponibles :`);
        paths.forEach(p => {
          const methods = Object.keys(swaggerSpec.paths[p]).join(', ').toUpperCase();
          console.log(`   [${methods}] ${p}`);
        });
      } catch {
        console.log(`   Contenu non-JSON (${raw.length} chars)`);
        fs.writeFileSync(swaggerOut + '.raw', raw, 'utf8');
        console.log(`   Brut sauvegardé → ${swaggerOut}.raw`);
      }
      break;
    } else {
      console.log(`   ${raw.slice(0, 200)}`);
    }
  }

  // 3. VehicleAssignments/current (avec registrationNumber) ─────────────────
  sep(`3. GET /VehicleAssignments/current?registrationNumber=${REG}`);

  {
    const url = `${BASE_API}/VehicleAssignments/current?registrationNumber=${encodeURIComponent(REG)}`;
    process.stdout.write(`[GET] ${url} → `);
    const { ok, status, raw, err } = await tryGet(fetch, url, authHeaders);
    if (err) {
      console.log(`ERREUR : ${err}`);
    } else {
      console.log(`HTTP ${status}`);
      if (ok) {
        try {
          const data = JSON.parse(raw);
          const arr  = Array.isArray(data) ? data : (data.items || data.results || data.data || [data]);
          console.log(`\n✅ ${arr.length} assignation(s)`);
          arr.slice(0, 3).forEach((item, i) => {
            console.log(`\n--- Assignation ${i + 1} (structure complète) ---`);
            console.log(JSON.stringify(item, null, 2));
          });
          printKeyFields(arr[0] ?? data);
        } catch {
          console.log(`   Réponse brute : ${raw.slice(0, 800)}`);
        }
      } else {
        // Si 400/404 avec registrationNumber, retenter sans filtre
        console.log(`   ${raw.slice(0, 400)}`);
        console.log('\n   → Nouvelle tentative sans filtre registrationNumber…');
        const { ok: ok2, status: s2, raw: r2, err: e2 } = await tryGet(
          fetch, `${BASE_API}/VehicleAssignments/current`, authHeaders
        );
        if (e2) { console.log(`   ERREUR : ${e2}`); }
        else {
          console.log(`   HTTP ${s2}`);
          if (ok2) {
            try {
              const data = JSON.parse(r2);
              const arr  = Array.isArray(data) ? data : (data.items || data.results || data.data || [data]);
              console.log(`   ✅ ${arr.length} assignation(s) (sans filtre)`);
              arr.slice(0, 2).forEach((item, i) => {
                console.log(`\n--- Assignation ${i + 1} ---`);
                console.log(JSON.stringify(item, null, 2));
              });
            } catch { console.log(`   Brut : ${r2.slice(0, 400)}`); }
          } else {
            console.log(`   ${r2.slice(0, 400)}`);
          }
        }
      }
    }
  }

  // 4. Persons ───────────────────────────────────────────────────────────────
  sep('4. GET /Persons');

  {
    const url = `${BASE_API}/Persons`;
    process.stdout.write(`[GET] ${url} → `);
    const { ok, status, raw, err } = await tryGet(fetch, url, authHeaders);
    if (err) {
      console.log(`ERREUR : ${err}`);
    } else {
      console.log(`HTTP ${status}`);
      if (ok) {
        try {
          const data = JSON.parse(raw);
          const arr  = Array.isArray(data) ? data : (data.items || data.results || data.data || data.persons || [data]);
          console.log(`\n✅ ${arr.length} personne(s)`);
          arr.slice(0, 3).forEach((p, i) => {
            console.log(`\n--- Personne ${i + 1} (structure complète) ---`);
            console.log(JSON.stringify(p, null, 2));
          });
        } catch {
          console.log(`   Réponse brute : ${raw.slice(0, 600)}`);
        }
      } else {
        console.log(`   ${raw.slice(0, 400)}`);
      }
    }
  }

  // 5. Vehicles/{registrationNumber} ─────────────────────────────────────────
  sep(`5. GET /Vehicles/${REG} — fiche véhicule individuelle`);

  {
    const url = `${BASE_API}/Vehicles/${encodeURIComponent(REG)}`;
    process.stdout.write(`[GET] ${url} → `);
    const { ok, status, raw, err } = await tryGet(fetch, url, authHeaders);
    if (err) {
      console.log(`ERREUR : ${err}`);
    } else {
      console.log(`HTTP ${status}`);
      if (ok) {
        try {
          const data = JSON.parse(raw);
          console.log('\n--- Fiche véhicule (structure complète) ---');
          console.log(JSON.stringify(data, null, 2));
          printKeyFields(data);
        } catch {
          console.log(`   Réponse brute : ${raw.slice(0, 600)}`);
        }
      } else {
        console.log(`   ${raw.slice(0, 400)}`);
        // Essai avec le registrationNumber en query param au lieu de path param
        console.log(`\n   → Tentative en query param : /Vehicles?registrationNumber=${REG}`);
        const { ok: ok2, status: s2, raw: r2, err: e2 } = await tryGet(
          fetch,
          `${BASE_API}/Vehicles?registrationNumber=${encodeURIComponent(REG)}`,
          authHeaders
        );
        if (e2) { console.log(`   ERREUR : ${e2}`); }
        else {
          console.log(`   HTTP ${s2}  ${r2.slice(0, 400)}`);
        }
      }
    }
  }

  // 6. Geolocation/Trips — 24h max, hier, ciblé sur EW-266-YQ ──────────────
  sep(`6. GET /Geolocation/Trips — hier, registrationNumber=${REG}`);

  {
    // Hier 00:00:00 → aujourd'hui 00:00:00 (fenêtre 24h exacte)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    const startDate = yesterday.toISOString().replace(/\.\d{3}Z$/, '');   // sans ms
    const endDate   = new Date(yesterday.getTime() + 24 * 3600 * 1000)
                        .toISOString().replace(/\.\d{3}Z$/, '');

    console.log(`   Fenêtre : ${startDate} → ${endDate}`);

    // Variantes de params dans l'ordre de probabilité pour cette API
    const paramVariants = [
      `startDate=${startDate}&endDate=${endDate}&registrationNumber=${encodeURIComponent(REG)}`,
      `startDate=${startDate}&endDate=${endDate}`,
      `from=${startDate}&to=${endDate}&registrationNumber=${encodeURIComponent(REG)}`,
      `from=${startDate}&to=${endDate}`,
      // Dates seules (format YYYY-MM-DD) au cas où l'API rejette les datetimes complets
      `startDate=${startDate.split('T')[0]}&endDate=${endDate.split('T')[0]}&registrationNumber=${encodeURIComponent(REG)}`,
      `startDate=${startDate.split('T')[0]}&endDate=${endDate.split('T')[0]}`,
    ];

    let found = false;
    for (const params of paramVariants) {
      const url = `${BASE_API}/Geolocation/Trips?${params}`;
      process.stdout.write(`[GET] ${url} → `);
      const { ok, status, raw, err } = await tryGet(fetch, url, authHeaders);
      if (err) { console.log(`ERREUR : ${err}`); continue; }
      console.log(`HTTP ${status}`);
      if (ok) {
        try {
          const data = JSON.parse(raw);
          const arr  = Array.isArray(data)
            ? data
            : (data.items || data.results || data.data || data.trips || data.journeys || []);
          console.log(`\n✅ ${arr.length} trajet(s)  [params: ${params.split('&').slice(-2).join('&')}…]`);
          if (arr.length > 0) {
            console.log('\n--- Premier trajet (structure complète) ---');
            console.log(JSON.stringify(arr[0], null, 2));
            printKeyFields(arr[0]);
          } else {
            console.log('   (tableau vide — réponse complète :)');
            console.log(JSON.stringify(data, null, 2));
          }
        } catch {
          console.log(`   Réponse brute : ${raw.slice(0, 600)}`);
        }
        found = true;
        break;
      } else {
        console.log(`   ${raw.slice(0, 300)}`);
      }
    }

    if (!found) {
      console.log('\n⚠️  Aucun variant de params n\'a fonctionné.');
      // Dernier recours : sans aucun param
      const url = `${BASE_API}/Geolocation/Trips`;
      process.stdout.write(`[GET] ${url} (sans params) → `);
      const { ok, status, raw, err } = await tryGet(fetch, url, authHeaders);
      if (err) { console.log(`ERREUR : ${err}`); }
      else      { console.log(`HTTP ${status}  ${raw.slice(0, 400)}`); }
    }
  }

  sep('FIN EXPLORATION');
  console.log(`\nSwagger complet : scripts/mapping-swagger.json`);
}

main().catch(e => {
  console.error('\n❌ Erreur fatale :', e.message);
  process.exit(1);
});
