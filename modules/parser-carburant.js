'use strict';
// Parse un export Excel de carte carburant Total.
// En-têtes réels sur la ligne 5 (lignes 1-4 = bandeau export).
// Détection dynamique via la cellule "Numéro de carte".

const xlsx = require('xlsx');

function normCol(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

// Correspondance colonnes Total → noms internes
// Noms réels Total en premier, alias génériques en repli
const COL_MAP = {
  // numéro carte
  numero_de_carte: 'numero_carte',
  no_carte: 'numero_carte', n_carte: 'numero_carte', carte: 'numero_carte',

  // immatriculation — "Information complémentaire" est la colonne primaire chez Total
  information_complementaire: 'immatriculation',
  // fallback : "Immatriculation véhicule/VIN" (normalisé → immatriculation_vehiculevin)
  immatriculation_vehiculevin: 'immatriculation_fallback',
  immatriculation: 'immatriculation', immat: 'immatriculation', vehicule: 'immatriculation',

  // conducteur composé : nom + prénom collaborateur, sinon code chauffeur
  nom_collaborateur: 'nom_collab',
  prenom_collaborateur: 'prenom_collab',
  code_chauffeur: 'code_chauffeur',
  // alias génériques conducteur
  nom_conducteur: 'nom_collab', conducteur: 'nom_collab',
  titulaire: 'nom_collab', porteur: 'nom_collab',

  // date
  date: 'date', date_transaction: 'date', date_de_transaction: 'date',
  date_dope: 'date', date_doperation: 'date',

  // heure
  heure: 'heure', heure_transaction: 'heure', heure_de_transaction: 'heure',
  time: 'heure', horaire: 'heure',

  // produit
  produit: 'produit', nature: 'produit', carburant: 'produit',
  type_de_produit: 'produit', designation: 'produit', libelle: 'produit',

  // quantité (litres) — filtré par Unité = 'L'
  quantite: 'quantite', qte: 'quantite', volume: 'quantite',
  litres: 'quantite', l: 'quantite', nb_litres: 'quantite', litre: 'quantite',

  // unité : on ne garde que les lignes avec 'L'
  unite: 'unite',

  // montant HT : "Montant HT - EUR" → normalisé → montant_ht__eur
  montant_ht__eur: 'montant_ht',
  montant_ht: 'montant_ht', montant_hors_taxe: 'montant_ht',
  montant_hors_taxes: 'montant_ht', montant: 'montant_ht',
  ht: 'montant_ht', net_ht: 'montant_ht',

  // prix unitaire : "Prix unitaire - EUR" → prix_unitaire__eur
  prix_unitaire__eur: 'prix_unitaire',
  prix_unitaire: 'prix_unitaire', prix_litre: 'prix_unitaire',

  // statut : filtrage des transactions annulées
  statut: 'statut', etat: 'statut',

  // kilométrage
  kilometrage: 'kilometrage', km: 'kilometrage',
  kilometrage_releve: 'kilometrage', index: 'kilometrage',
  releve_km: 'kilometrage', kilom: 'kilometrage', compteur: 'kilometrage',

  // ville / station
  ville: 'ville', ville_station: 'ville', localisation: 'ville',
  commune: 'ville', lieu: 'ville', station: 'ville',
};

function parseFR(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

function parseDateFR(dateVal) {
  if (!dateVal && dateVal !== 0) return null;
  if (dateVal instanceof Date) return dateVal.toISOString().slice(0, 10);
  if (typeof dateVal === 'number') {
    try {
      const d = xlsx.SSF.parse_date_code(dateVal);
      return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
    } catch { return null; }
  }
  const s = String(dateVal).trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

function parseHeure(heureVal) {
  if (!heureVal && heureVal !== 0) return '00:00';
  if (heureVal instanceof Date) {
    return `${String(heureVal.getHours()).padStart(2,'0')}:${String(heureVal.getMinutes()).padStart(2,'0')}`;
  }
  const s = String(heureVal).trim();
  const m = s.match(/^(\d{1,2})[h:\-](\d{2})/i);
  if (m) return `${m[1].padStart(2,'0')}:${m[2]}`;
  if (/^\d{4}$/.test(s)) return s.slice(0,2)+':'+s.slice(2);
  return '00:00';
}

// Trouve la ligne d'en-tête en cherchant la cellule "Numéro de carte"
// (les lignes 1-4 du fichier Total sont un bandeau d'export à ignorer)
function detectHeader(rawRows) {
  for (let i = 0; i < Math.min(15, rawRows.length); i++) {
    const row = rawRows[i];
    if (!row) continue;
    const cells = Array.isArray(row) ? row : Object.values(row);
    for (const cell of cells) {
      if (normCol(cell) === 'numero_de_carte') return i;
    }
  }
  // Repli : première ligne avec au moins 4 colonnes reconnues
  for (let i = 0; i < Math.min(15, rawRows.length); i++) {
    const row = rawRows[i];
    if (!row) continue;
    const cells = Array.isArray(row) ? row : Object.values(row);
    let matched = 0;
    for (const cell of cells) { if (COL_MAP[normCol(cell)]) matched++; }
    if (matched >= 4) return i;
  }
  return 0;
}

function parseCarburant(buffer) {
  const wb = xlsx.read(buffer, { type: 'buffer', cellDates: true, raw: false });

  // Feuille la plus grande
  let ws = null, maxRows = 0;
  for (const name of wb.SheetNames) {
    const s = wb.Sheets[name];
    if (!s['!ref']) continue;
    const range = xlsx.utils.decode_range(s['!ref']);
    if (range.e.r > maxRows) { maxRows = range.e.r; ws = s; }
  }
  if (!ws) throw new Error('Aucune feuille avec données dans le fichier');

  const rawRows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  const headerIdx = detectHeader(rawRows);
  const headerRow = rawRows[headerIdx];

  // mapping index colonne → champ interne
  const colIdxMap = {};
  for (let c = 0; c < headerRow.length; c++) {
    const norm = normCol(headerRow[c]);
    if (COL_MAP[norm]) colIdxMap[c] = COL_MAP[norm];
  }

  if (Object.keys(colIdxMap).length < 3) {
    throw new Error(
      `Colonnes non reconnues (${Object.keys(colIdxMap).length} matchées). ` +
      `En-tête ligne ${headerIdx + 1} : ${headerRow.join(' | ')}`
    );
  }

  const transactions = [];
  for (let r = headerIdx + 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!row || row.every(v => v === '' || v == null)) continue;

    const t = {};
    for (const [idxStr, field] of Object.entries(colIdxMap)) {
      t[field] = row[parseInt(idxStr)];
    }

    // ── Filtre Unité : garder seulement les litres ─────────────────────────
    const unite = String(t.unite || '').trim().toUpperCase();
    if (t.unite !== undefined && unite !== 'L') continue;

    // ── Filtre Statut : ignorer les transactions annulées ──────────────────
    const statut = String(t.statut || '').trim().toLowerCase();
    if (statut && statut.includes('annul')) continue;

    const litres      = parseFR(t.quantite);
    const montantHt   = parseFR(t.montant_ht);
    const prixUnitaire = parseFR(t.prix_unitaire);
    const km          = parseFR(t.kilometrage);
    const dateStr     = parseDateFR(t.date);
    const heureStr    = parseHeure(t.heure);

    if (!dateStr || litres === null || litres <= 0) continue;

    // ── Immatriculation : Info complémentaire en priorité ─────────────────
    const immatRaw = String(t.immatriculation || t.immatriculation_fallback || '').trim();
    const immat = immatRaw.toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9\-]/g, '');

    // ── Conducteur : Nom + Prénom collaborateur, sinon code chauffeur ──────
    const nom    = String(t.nom_collab   || '').trim();
    const prenom = String(t.prenom_collab || '').trim();
    const conducteur = (nom || prenom)
      ? [prenom, nom].filter(Boolean).join(' ')
      : String(t.code_chauffeur || '').trim();

    transactions.push({
      numero_carte:    String(t.numero_carte || '').trim(),
      immatriculation: immat,
      date:            dateStr,
      heure:           heureStr,
      datetime:        `${dateStr}T${heureStr}:00`,
      produit:         String(t.produit || '').trim(),
      litres,
      montant_ht:      montantHt,
      prix_unitaire:   prixUnitaire,
      kilometrage:     km,
      conducteur,
      ville:           String(t.ville || '').trim(),
    });
  }

  if (!transactions.length) {
    throw new Error(`0 transaction valide extraite (${rawRows.length - headerIdx - 1} lignes lues)`);
  }

  return transactions;
}

module.exports = { parseCarburant };
