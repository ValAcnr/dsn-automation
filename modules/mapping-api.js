'use strict';
// Client partagé pour l'API Optimum Automotive Mapping Control.
// Utilisé par la route /api/carburant/import et potentiellement d'autres routes.

const fs   = require('fs');
const path = require('path');

// Charge .env si les variables ne sont pas encore définies
const _envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(_envPath)) {
  fs.readFileSync(_envPath, 'utf8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq === -1 || line.trimStart().startsWith('#')) return;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !process.env[key]) process.env[key] = val;
  });
}

const BASE_API      = 'https://apicore-preprod.optimum-automotive.com';
const RATE_LIMIT_MS = 2100;
const RETRY_429_MS  = 65000;

const TOKEN_CANDIDATES = [
  'https://identityserver-preprod.optimum-automotive.com/connect/token',
  'https://identityserver-preprod.optimum-automotive.com/oauth2/token',
  'https://identityserver-preprod.optimum-automotive.com/oauth/token',
  `${BASE_API}/connect/token`,
  `${BASE_API}/oauth2/token`,
];

// Token mis en cache jusqu'à expiration
let _cachedToken  = null;
let _tokenExpiry  = 0;
let _fetchMod     = null;
let _lastCallTime = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _getFetch() {
  if (!_fetchMod) _fetchMod = (await import('node-fetch')).default;
  return _fetchMod;
}

function hasCredentials() {
  return !!(process.env.MAPPING_CLIENT_ID && process.env.MAPPING_CLIENT_SECRET);
}

async function getToken() {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;
  if (!hasCredentials()) throw new Error('MAPPING_CLIENT_ID / MAPPING_CLIENT_SECRET absents');

  const fetch = await _getFetch();
  const body  = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     process.env.MAPPING_CLIENT_ID,
    client_secret: process.env.MAPPING_CLIENT_SECRET,
  });

  for (const url of TOKEN_CANDIDATES) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) {
        const j = await r.json();
        _cachedToken = j.access_token;
        _tokenExpiry = Date.now() + (j.expires_in ? (j.expires_in - 60) * 1000 : 3540000);
        return _cachedToken;
      }
    } catch { /* essaie le suivant */ }
  }
  throw new Error('Impossible d\'obtenir un token OAuth2 Mapping Control');
}

// Respecte le rate limit (2.1s entre appels) + retry sur 429
async function apiGet(urlPath, params) {
  const fetch = await _getFetch();

  const elapsed = Date.now() - _lastCallTime;
  if (elapsed < RATE_LIMIT_MS) await sleep(RATE_LIMIT_MS - elapsed);

  const token   = await getToken();
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const qs      = params ? '?' + new URLSearchParams(params).toString() : '';
  const url     = `${BASE_API}${urlPath}${qs}`;

  const doFetch = () => fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  let r = await doFetch();
  _lastCallTime = Date.now();

  if (r.status === 429) {
    console.warn(`[mapping-api] ⏳ 429 Rate Limit — attente ${RETRY_429_MS / 1000} s…`);
    await sleep(RETRY_429_MS);
    r = await doFetch();
    _lastCallTime = Date.now();
    if (r.status === 429) throw new Error(`HTTP 429 persistant : ${url}`);
  }

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`HTTP ${r.status} ${urlPath} — ${body.slice(0, 200)}`);
  }
  return r.json();
}

function toArr(data, ...keys) {
  if (Array.isArray(data)) return data;
  for (const k of keys) if (Array.isArray(data[k])) return data[k];
  return Object.values(data).find(v => Array.isArray(v)) || [];
}

module.exports = { apiGet, getToken, hasCredentials, toArr, BASE_API };
