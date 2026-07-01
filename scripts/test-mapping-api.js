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

  // Lecture des params swagger pour /Geolocation/Trips
  let tripQueryParams = null;
  if (swaggerSpec && swaggerSpec.paths) {
    const tripPath = Object.keys(swaggerSpec.paths).find(p =>
      p.toLowerCase().includes('geolocation') && p.toLowerCase().includes('trip')
    );
    if (tripPath) {
      const getOp = swaggerSpec.paths[tripPath].get;
      if (getOp && getOp.parameters) {
        tripQueryParams = getOp.parameters.map(p => ({ name: p.name, in: p.in, required: p.required }));
        console.log(`\n   Params swagger pour ${tripPath} :`);
        tripQueryParams.forEach(p => console.log(`     ${p.required ? '*' : ' '} ${p.name} (${p.in})`));
      }
    }
  }

  // 3. VehicleAssignments/current ────────────────────────────────────────────
  sep('3. GET /VehicleAssignments/current');

  {
    const url = `${BASE_API}/VehicleAssignments/current`;
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
          console.log('\n--- Premier élément (structure complète) ---');
          console.log(JSON.stringify(arr[0] ?? data, null, 2));
          if (arr.length > 1) {
            console.log('\n--- Deuxième élément ---');
            console.log(JSON.stringify(arr[1], null, 2));
          }
        } catch {
          console.log(`   Réponse brute : ${raw.slice(0, 600)}`);
        }
      } else {
        console.log(`   ${raw.slice(0, 400)}`);
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
          const preview = arr.slice(0, 3);
          preview.forEach((p, i) => {
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

  // 5. Geolocation/Trips ─────────────────────────────────────────────────────
  sep('5. GET /Geolocation/Trips');

  {
    const today    = new Date().toISOString().split('T')[0];
    const weekAgo  = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

    // Construit les query params en lisant le swagger si disponible,
    // sinon tente les variantes les plus communes
    const paramVariants = [
      // Format ISO dates (le plus courant dans ce type d'API)
      `startDate=${weekAgo}&endDate=${today}`,
      `from=${weekAgo}&to=${today}`,
      `dateDebut=${weekAgo}&dateFin=${today}`,
      `StartDate=${weekAgo}&EndDate=${today}`,
      `FromDate=${weekAgo}&ToDate=${today}`,
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
          const arr  = Array.isArray(data) ? data : (data.items || data.results || data.data || data.trips || []);
          console.log(`\n✅ ${arr.length} trajet(s) avec params : ${params}`);
          if (arr.length > 0) {
            console.log('\n--- Premier trajet (structure complète) ---');
            console.log(JSON.stringify(arr[0], null, 2));
            console.log('\n--- Champs clés présents ? ---');
            const sample = arr[0];
            const keys   = Object.keys(sample);
            console.log(`   Tous les champs : ${keys.join(', ')}`);
            ['driver', 'conducteur', 'driverId', 'driverName', 'personId', 'userId',
             'duration', 'drivingTime', 'amplitude', 'distance', 'km',
             'startDate', 'endDate', 'date', 'vehicle', 'vehicleId',
             'registrationNumber', 'plate', 'immatriculation']
              .forEach(k => {
                const found = keys.find(key => key.toLowerCase().includes(k.toLowerCase()));
                if (found) console.log(`   ✓ "${found}" = ${JSON.stringify(sample[found])}`);
              });
          } else {
            console.log('--- Réponse complète (tableau vide ou structure différente) ---');
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
      console.log('\n⚠️  Aucun variant de params n\'a fonctionné pour /Geolocation/Trips');
      // Essai sans params
      const url = `${BASE_API}/Geolocation/Trips`;
      process.stdout.write(`[GET] ${url} (sans params) → `);
      const { ok, status, raw, err } = await tryGet(fetch, url, authHeaders);
      if (err) { console.log(`ERREUR : ${err}`); }
      else {
        console.log(`HTTP ${status}  ${raw.slice(0, 400)}`);
      }
    }
  }

  sep('FIN EXPLORATION');
  console.log(`\nSwagger complet : scripts/mapping-swagger.json`);
}

main().catch(e => {
  console.error('\n❌ Erreur fatale :', e.message);
  process.exit(1);
});
