'use strict';
// Parse un export Excel de carte carburant Total.
// Gère les variantes de nommage des colonnes et les formats de date FR.

const xlsx = require('xlsx');

function normCol(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

// Correspondance colonnes Total → noms internes
const COL_MAP = {
  // numéro carte
  no_carte: 'numero_carte', n_carte: 'numero_carte',
  numero_de_carte: 'numero_carte', numero_carte: 'numero_carte',
  carte: 'numero_carte', num_carte: 'numero_carte',
  // immatriculation — champ spécifique Total
  mention_complementaire: 'immatriculation',
  mention_comp: 'immatriculation',
  immatriculation: 'immatriculation', immat: 'immatriculation',
  vehicule: 'immatriculation',
  // date
  date: 'date', date_transaction: 'date', date_de_transaction: 'date',
  date_d_operation: 'date', date_ope: 'date',
  // heure
  heure: 'heure', heure_transaction: 'heure', heure_de_transaction: 'heure',
  time: 'heure', horaire: 'heure',
  // produit
  nature: 'produit', produit: 'produit', carburant: 'produit',
  type_de_produit: 'produit', designation: 'produit', libelle: 'produit',
  // litres
  quantite: 'litres', qte: 'litres', volume: 'litres',
  litres: 'litres', l: 'litres', quantite_l: 'litres',
  nb_litres: 'litres', litre: 'litres',
  // montant HT
  montant_ht: 'montant_ht', montant_hors_taxe: 'montant_ht',
  montant_hors_taxes: 'montant_ht', montant: 'montant_ht',
  ht: 'montant_ht', montant_h_t: 'montant_ht', net_ht: 'montant_ht',
  // kilométrage
  kilometrage: 'kilometrage', km: 'kilometrage',
  kilometrage_releve: 'kilometrage', index: 'kilometrage',
  releve_km: 'kilometrage', kilom: 'kilometrage', compteur: 'kilometrage',
  // conducteur
  nom_conducteur: 'conducteur', conducteur: 'conducteur',
  nom: 'conducteur', titulaire: 'conducteur', porteur: 'conducteur',
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
    // Numéro de série Excel : xlsx avec cellDates:false
    try {
      const d = xlsx.SSF.parse_date_code(dateVal);
      return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
    } catch { return null; }
  }
  const s = String(dateVal).trim();
  // DD/MM/YYYY ou DD-MM-YYYY
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  // YYYY-MM-DD déjà ISO
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

// Trouve la ligne d'en-tête (la première qui contient au moins 3 colonnes reconnues)
function detectHeader(rawRows) {
  for (let i = 0; i < Math.min(10, rawRows.length); i++) {
    const row = rawRows[i];
    if (!row) continue;
    const cells = Array.isArray(row) ? row : Object.values(row);
    let matched = 0;
    for (const cell of cells) {
      if (COL_MAP[normCol(cell)]) matched++;
    }
    if (matched >= 3) return i;
  }
  return 0;
}

function parseCarburant(buffer) {
  const wb = xlsx.read(buffer, { type: 'buffer', cellDates: true, raw: false });

  // Cherche la feuille la plus grande
  let ws = null, maxRows = 0;
  for (const name of wb.SheetNames) {
    const s = wb.Sheets[name];
    if (!s['!ref']) continue;
    const range = xlsx.utils.decode_range(s['!ref']);
    if (range.e.r > maxRows) { maxRows = range.e.r; ws = s; }
  }
  if (!ws) throw new Error('Aucune feuille avec données dans le fichier');

  // Lecture brute pour détecter la ligne d'en-tête
  const rawRows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  const headerIdx = detectHeader(rawRows);
  const headerRow = rawRows[headerIdx];

  // Construire le mapping index → champ interne
  const colIdxMap = {};
  for (let c = 0; c < headerRow.length; c++) {
    const norm = normCol(headerRow[c]);
    if (COL_MAP[norm]) colIdxMap[c] = COL_MAP[norm];
  }

  if (Object.keys(colIdxMap).length < 3) {
    throw new Error(
      `Colonnes non reconnues (${Object.keys(colIdxMap).length} matchées). ` +
      `En-tête détectée à la ligne ${headerIdx + 1} : ${headerRow.join(' | ')}`
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

    const litres    = parseFR(t.litres);
    const montantHt = parseFR(t.montant_ht);
    const km        = parseFR(t.kilometrage);
    const dateStr   = parseDateFR(t.date);
    const heureStr  = parseHeure(t.heure);

    if (!dateStr || litres === null || litres <= 0) continue;

    const immat = String(t.immatriculation || '').trim().toUpperCase()
      .replace(/\s+/g, '').replace(/[^A-Z0-9\-]/g, '');

    transactions.push({
      numero_carte:    String(t.numero_carte || '').trim(),
      immatriculation: immat,
      date:            dateStr,
      heure:           heureStr,
      datetime:        `${dateStr}T${heureStr}:00`,
      produit:         String(t.produit || '').trim(),
      litres,
      montant_ht:      montantHt,
      kilometrage:     km,
      conducteur:      String(t.conducteur || '').trim(),
      ville:           String(t.ville || '').trim(),
    });
  }

  if (!transactions.length) {
    throw new Error(`0 transaction valide extraite (${rawRows.length - headerIdx - 1} lignes de données lues)`);
  }

  return transactions;
}

module.exports = { parseCarburant };
