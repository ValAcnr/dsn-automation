'use strict';

const { readWorkbook, getSheetData, replaceSheet } = require('./excel');
const logger = require('./logger');

// Strip accents and uppercase for fuzzy name matching
function norm(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .trim()
    .replace(/\s+/g, ' ');
}

// Match Mapping conducteur (PRENOM NOM or NOM PRENOM, double spaces) against Feuilles nom/prenom
function matchConducteur(conducteur, nom, prenom) {
  const c = norm(conducteur);
  const n = norm(nom);
  const p = norm(prenom);
  if (!c || !n || !p) return false;
  return c === `${n} ${p}` || c === `${p} ${n}`;
}

// Extract numeric week from formats: "2026.24", "24", "S24", "SEM 24", "24/2026"
function parseSemaine(raw) {
  const s = String(raw || '');
  const m = s.match(/(?:sem\.?\s*)?(\d{1,2})(?:\/\d{4})?(?:\.\d+)?$/i) ||
            s.match(/(\d{1,2})/);
  if (!m) return s;
  // Prefer last match for "2026.24" → group 1 of first regex is "24"
  const full = s.match(/\d{4}\.(\d{2})/);
  if (full) return full[1];
  return m[1].padStart(2, '0');
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function recalculer() {
  try {
    const wb = readWorkbook();
    const feuilles = getSheetData(wb, 'Feuilles');
    const factures = getSheetData(wb, 'Facture');
    const mappings = getSheetData(wb, 'Mapping');

    const controles = [];

    for (const f of feuilles) {
      const semaine = parseSemaine(f.semaine);
      const heuresSigne = parseFloat(f.total_heures) || 0;
      const nom = f.nom;
      const prenom = f.prenom;

      // ── Feuilles vs Facture ──────────────────────────────────────────────
      const lignesFacture = factures.filter((fac) => {
        const s = parseSemaine(fac.numero_semaine || fac.semaine);
        return s === semaine && norm(fac.nom) === norm(nom) && norm(fac.prenom) === norm(prenom);
      });

      let heuresFacturees = 0;
      let ecartFacture = 0;
      let statutFacture;

      if (lignesFacture.length > 0) {
        heuresFacturees = lignesFacture.reduce(
          (acc, fac) => acc + (parseFloat(fac.heures_normales) || 0) + (parseFloat(fac.heures_feries) || 0),
          0,
        );
        ecartFacture = Math.abs(heuresSigne - heuresFacturees);

        if (heuresSigne === 0 && heuresFacturees > 0) {
          statutFacture = 'NON FACTURE';
        } else if (ecartFacture > 0.5) {
          statutFacture = 'ALERTE';
        } else {
          statutFacture = 'OK';
        }
      } else {
        // Invoice exists for the week but this worker is absent from it
        const factureSemaineTrouvee = factures.some((fac) => parseSemaine(fac.numero_semaine || fac.semaine) === semaine);
        statutFacture = factureSemaineTrouvee ? 'NON FACTURE' : 'EN ATTENTE';
      }

      // ── Feuilles vs Mapping ──────────────────────────────────────────────
      const joursOuvres = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']
        .filter((j) => parseFloat(f[`h_${j}`]) > 0).length;

      const lignesMapping = mappings.filter((m) => {
        const ms = parseSemaine(m.numero_semaine);
        return ms === semaine && matchConducteur(m.conducteur, nom, prenom);
      });

      let heuresVehicule = 0;
      let ecartMapping = 0;
      let vehiculeActif = 'NON';
      let statutMapping;

      if (lignesMapping.length > 0) {
        heuresVehicule = lignesMapping.reduce((acc, m) => acc + (parseFloat(m.amplitude_totale) || 0), 0);
        vehiculeActif = lignesMapping.some((m) => m.statut_vehicule === 'ACTIF') ? 'OUI' : 'NON';
        ecartMapping = Math.abs(heuresSigne - heuresVehicule);

        const hasImmobile = lignesMapping.some((m) => m.statut_vehicule === 'IMMOBILE');
        const joursGPS = lignesMapping.length;

        if (joursOuvres > 0 && joursGPS < joursOuvres) {
          statutMapping = 'EN ATTENTE'; // GPS data incomplete for the week
        } else if (hasImmobile || ecartMapping > 1.5) {
          statutMapping = 'ALERTE';
        } else {
          statutMapping = 'OK';
        }
      } else {
        const mappingSemaineTrouve = mappings.some((m) => parseSemaine(m.numero_semaine) === semaine);
        statutMapping = mappingSemaineTrouve ? 'ALERTE' : 'EN ATTENTE';
      }

      // ── Niveau alerte global ─────────────────────────────────────────────
      const hasImmobile = lignesMapping.some((m) => m.statut_vehicule === 'IMMOBILE');
      let niveauAlerte;
      const details = [];

      if (statutFacture === 'EN ATTENTE' || statutMapping === 'EN ATTENTE') {
        niveauAlerte = 'EN ATTENTE';
        details.push('Données manquantes');
      } else if (ecartFacture > 3 || ecartMapping > 3 || hasImmobile) {
        niveauAlerte = 'CRITIQUE';
        if (ecartFacture > 3) details.push(`Écart facture ${round2(ecartFacture)}h`);
        if (ecartMapping > 3) details.push(`Écart GPS ${round2(ecartMapping)}h`);
        if (hasImmobile) details.push('Véhicule IMMOBILE');
      } else if (statutFacture !== 'OK' || statutMapping !== 'OK') {
        niveauAlerte = 'ATTENTION';
        if (statutFacture === 'ALERTE') details.push(`Écart facture ${round2(ecartFacture)}h`);
        if (statutFacture === 'NON FACTURE') details.push('Non facturé');
        if (statutMapping === 'ALERTE') details.push(`Écart GPS ${round2(ecartMapping)}h`);
      } else {
        niveauAlerte = 'OK';
        details.push('Tout OK');
      }

      controles.push({
        nom,
        prenom,
        semaine: f.semaine,
        heures_signees: heuresSigne,
        heures_facturees: round2(heuresFacturees),
        ecart_facture: round2(ecartFacture),
        statut_facture: statutFacture,
        heures_vehicule: round2(heuresVehicule),
        ecart_mapping: round2(ecartMapping),
        vehicule_actif: vehiculeActif,
        statut_mapping: statutMapping,
        niveau_alerte: niveauAlerte,
        detail: details.join(' | '),
      });
    }

    await replaceSheet('Controles', controles);
    logger.ok(`Contrôles recalculés : ${controles.length} ligne(s)`);
  } catch (err) {
    logger.err(`Erreur calcul contrôles : ${err.message}`);
  }
}

module.exports = { recalculer };
