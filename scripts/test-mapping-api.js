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

  // 3. Liste véhicules → trouver un véhicule actif AVEC conducteur assigné ────
  sep('3. GET /Vehicles — véhicule actif avec currentDriver non-null');

  const PREFERRED_REG = 'DF-017-KV';  // priorité si présent et actif avec conducteur
  let activeReg  = null;
  let tripsReg   = null;  // véhicule retenu pour l'étape 7

  {
    const url = `${BASE_API}/Vehicles`;
    process.stdout.write(`[GET] ${url} → `);
    const { ok, status, raw, err } = await tryGet(fetch, url, authHeaders);
    if (err) {
      console.log(`ERREUR : ${err}`);
    } else {
      console.log(`HTTP ${status}`);
      if (ok) {
        try {
          const data  = JSON.parse(raw);
          const all   = Array.isArray(data) ? data : (data.items || data.results || data.data || data.vehicles || [data]);

          function getReg(v) {
            return v.registrationNumber || v.plate || v.immatriculation || String(v.id || '');
          }
          function hasDriver(v) {
            return v.currentDriver !== null && v.currentDriver !== undefined
                && v.currentDriver !== ''
                && !(typeof v.currentDriver === 'object' && Object.keys(v.currentDriver).length === 0);
          }

          const active = all.filter(v => {
            const st = (v.status || v.fleetStatus || v.vehicleStatus || '').toString().toUpperCase();
            return st !== 'OUT_FLEET' && st !== 'OUT OF FLEET';
          });
          const withDriver = active.filter(hasDriver);

          console.log(`\n✅ ${all.length} véhicules au total, ${active.length} actifs, ${withDriver.length} avec currentDriver non-null`);

          console.log('\n--- 3 premiers véhicules actifs avec conducteur ---');
          withDriver.slice(0, 3).forEach((v, i) => {
            const reg    = getReg(v);
            const driver = JSON.stringify(v.currentDriver);
            const st     = v.status || v.fleetStatus || '(no status field)';
            console.log(`   ${i + 1}. ${reg}  |  status: ${st}  |  currentDriver: ${driver}`);
          });

          // Priorité : DF-017-KV s'il est dans withDriver
          const preferred = withDriver.find(v => getReg(v) === PREFERRED_REG);
          if (preferred) {
            tripsReg = PREFERRED_REG;
            console.log(`\n   → DF-017-KV trouvé avec conducteur : retenu pour l'étape 7`);
          } else if (withDriver.length > 0) {
            tripsReg = getReg(withDriver[0]);
            console.log(`\n   → DF-017-KV absent/sans conducteur — premier véhicule avec conducteur retenu : ${tripsReg}`);
          } else {
            // Fallback : premier actif sans conducteur
            tripsReg = active.length > 0 ? getReg(active[0]) : null;
            console.log(`\n⚠️  Aucun véhicule avec currentDriver non-null — fallback sur le premier actif : ${tripsReg || '(aucun)'}`);
          }

          if (active.length > 0) {
            activeReg = getReg(active[0]);
          } else {
            console.log('\n⚠️  Aucun véhicule actif trouvé.');
          }
        } catch {
          console.log(`   Réponse brute : ${raw.slice(0, 600)}`);
        }
      } else {
        console.log(`   ${raw.slice(0, 400)}`);
      }
    }
  }

  if (!activeReg) {
    console.log('\n⚠️  Impossible de déterminer un véhicule actif. Les étapes suivantes seront skippées.');
  }

  // 4. VehicleAssignments/current (avec registrationNumber actif) ────────────
  sep(`4. GET /VehicleAssignments/current?registrationNumber=${activeReg || '(inconnu)'}`);

  {
    if (!activeReg) { console.log('   (skippé — pas de véhicule actif)'); }
    else {
    const url = `${BASE_API}/VehicleAssignments/current?registrationNumber=${encodeURIComponent(activeReg)}`;
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
    } // fin if (activeReg)
  }

  // 5. Persons ───────────────────────────────────────────────────────────────
  sep('5. GET /Persons');

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

  // 6. Vehicles/{registrationNumber} ─────────────────────────────────────────
  sep(`6. GET /Vehicles/${activeReg || '(inconnu)'} — fiche véhicule individuelle`);

  {
    if (!activeReg) { console.log('   (skippé — pas de véhicule actif)'); }
    else {
    const url = `${BASE_API}/Vehicles/${encodeURIComponent(activeReg)}`;
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
        console.log(`\n   → Tentative en query param : /Vehicles?registrationNumber=${activeReg}`);
        const { ok: ok2, status: s2, raw: r2, err: e2 } = await tryGet(
          fetch,
          `${BASE_API}/Vehicles?registrationNumber=${encodeURIComponent(activeReg)}`,
          authHeaders
        );
        if (e2) { console.log(`   ERREUR : ${e2}`); }
        else {
          console.log(`   HTTP ${s2}  ${r2.slice(0, 400)}`);
        }
      }
    }
    } // fin if (activeReg)
  }

  // 7. Geolocation/Trips — véhicule avec conducteur, hier, tous les trajets ───
  const TRIPS_REG = tripsReg || 'CR-860-YB';  // fallback si étape 3 a échoué
  sep(`7. GET /Geolocation/Trips — hier, registrationNumber=${TRIPS_REG} (tous les trajets)`);

  {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    const startDate = yesterday.toISOString().replace(/\.\d{3}Z$/, '');
    const endDate   = new Date(yesterday.getTime() + 24 * 3600 * 1000)
                        .toISOString().replace(/\.\d{3}Z$/, '');
    const regEnc    = encodeURIComponent(TRIPS_REG);

    console.log(`   Fenêtre : ${startDate} → ${endDate}`);

    const paramVariants = [
      `startDate=${startDate}&endDate=${endDate}&registrationNumber=${regEnc}`,
      `startDate=${startDate}&endDate=${endDate}`,
      `from=${startDate}&to=${endDate}&registrationNumber=${regEnc}`,
      `from=${startDate}&to=${endDate}`,
      `startDate=${startDate.split('T')[0]}&endDate=${endDate.split('T')[0]}&registrationNumber=${regEnc}`,
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
          console.log(`\n✅ ${arr.length} trajet(s)`);

          if (arr.length > 0) {
            // Structure complète du premier trajet (référence)
            console.log('\n--- Premier trajet (structure complète) ---');
            console.log(JSON.stringify(arr[0], null, 2));

            // Résumé de tous les trajets : driver + startPoint.date + duration
            console.log(`\n--- Résumé de tous les trajets (driver / startPoint.date / duration) ---`);
            arr.forEach((t, i) => {
              const driver   = t.driver !== undefined ? JSON.stringify(t.driver) : '(champ absent)';
              const date     = t.startPoint?.date ?? t.startDate ?? t.date ?? '(absent)';
              const duration = t.duration ?? t.drivingTime ?? t.durationSeconds ?? '(absent)';
              console.log(`   ${String(i + 1).padStart(2)}. driver=${driver}  date=${date}  duration=${duration}`);
            });

            const withDriver = arr.filter(t => t.driver !== null && t.driver !== undefined);
            console.log(`\n   → ${withDriver.length}/${arr.length} trajet(s) avec driver non-null`);
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
      const url = `${BASE_API}/Geolocation/Trips`;
      process.stdout.write(`[GET] ${url} (sans params) → `);
      const { ok, status, raw, err } = await tryGet(fetch, url, authHeaders);
      if (err) { console.log(`ERREUR : ${err}`); }
      else      { console.log(`HTTP ${status}  ${raw.slice(0, 400)}`); }
    }
  }

  // 8. Schéma swagger du champ "driver" dans /Geolocation/Trips ──────────────
  sep('8. SWAGGER SCHEMA — champ "driver" dans /Geolocation/Trips');

  {
    const swaggerPath = path.join(__dirname, 'mapping-swagger.json');
    if (!fs.existsSync(swaggerPath)) {
      console.log('   mapping-swagger.json absent — relancer le script pour le générer.');
    } else {
      try {
        const spec = JSON.parse(fs.readFileSync(swaggerPath, 'utf8'));

        // Trouve le path /Geolocation/Trips (insensible à la casse)
        const tripPath = Object.keys(spec.paths || {}).find(p =>
          p.toLowerCase().includes('geolocation') && p.toLowerCase().includes('trip')
        );
        if (!tripPath) {
          console.log('   Aucun path /Geolocation/Trips dans le swagger.');
        } else {
          console.log(`   Path trouvé : ${tripPath}`);
          const getOp = spec.paths[tripPath].get || {};

          // Params query
          if (getOp.parameters?.length) {
            console.log('\n   Paramètres query :');
            getOp.parameters.forEach(p =>
              console.log(`     ${p.required ? '*' : ' '} ${p.name} (${p.in}) — ${p.description || p.schema?.type || ''}`)
            );
          }

          // Schéma de réponse 200
          const resp200 = getOp.responses?.['200'] || getOp.responses?.['default'];
          let schemaRef = resp200?.content?.['application/json']?.schema
                       || resp200?.schema;

          // Résout $ref si besoin
          function resolveRef(ref, root) {
            if (!ref || !ref.startsWith('#/')) return null;
            return ref.slice(2).split('/').reduce((o, k) => o?.[k], root);
          }

          if (schemaRef?.$ref) schemaRef = resolveRef(schemaRef.$ref, spec);

          // Cas tableau : items peut être le vrai schéma
          if (schemaRef?.type === 'array' && schemaRef.items) {
            const items = schemaRef.items;
            schemaRef = items.$ref ? resolveRef(items.$ref, spec) : items;
          }

          if (!schemaRef) {
            console.log('\n   Impossible de résoudre le schéma de réponse.');
          } else {
            const props = schemaRef.properties || {};
            console.log(`\n   Schéma de réponse résolu : ${schemaRef.title || schemaRef['x-schemaName'] || '(anonyme)'}`);
            console.log(`   Champs disponibles : ${Object.keys(props).join(', ')}`);

            // Champ driver
            const driverProp = props['driver'] || props['Driver'];
            if (driverProp) {
              const resolved = driverProp.$ref ? resolveRef(driverProp.$ref, spec) : driverProp;
              console.log('\n   --- Définition du champ "driver" ---');
              console.log(JSON.stringify(resolved, null, 2));
            } else {
              console.log('\n   Champ "driver" absent des properties du schéma.');
              // Recherche large dans tout le swagger
              const raw = JSON.stringify(spec);
              const idx = raw.toLowerCase().indexOf('"driver"');
              if (idx !== -1) {
                console.log(`   Occurrence de "driver" dans le swagger brut (contexte) :`);
                console.log('   ' + raw.slice(Math.max(0, idx - 80), idx + 200));
              }
            }
          }
        }
      } catch (e) {
        console.log(`   Erreur lecture swagger : ${e.message}`);
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
