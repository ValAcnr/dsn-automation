'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appendRow, replaceSheet, getSheetData, readWorkbook } = require('./excel');
const calcul = require('./calcul-controles');
const logger = require('./logger');

const PDF_DIR = path.join(__dirname, '..', 'pdfs');
const CINQ_ANS_MS = 5 * 365.25 * 24 * 3600 * 1000;

function ensureDirs() {
  if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function parseNumSemaine(semaine) {
  const s = String(semaine || '');
  const m = s.match(/\d{4}\.(\d{2})/) || s.match(/(\d{1,2})/);
  return m ? m[1].padStart(2, '0') : s;
}

function safeFilePart(str) {
  return (str || '').toUpperCase().trim().replace(/[^A-Z0-9]/gi, '_').replace(/_+/g, '_');
}

function normStr(s) {
  return String(s || '').toUpperCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function nettoyerAnciensPdfs() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(PDF_DIR)) {
      if (!f.toLowerCase().endsWith('.pdf')) continue;
      const stat = fs.statSync(path.join(PDF_DIR, f));
      if (now - stat.mtimeMs > CINQ_ANS_MS) {
        fs.unlinkSync(path.join(PDF_DIR, f));
        logger.info(`PDF supprimé (plus de 5 ans) : ${f}`);
      }
    }
  } catch (e) {
    logger.warn(`Nettoyage PDFs anciens : ${e.message}`);
  }
}

async function handleFeuille(req, res) {
  try {
    ensureDirs();
    const data = req.body || {};

    const nom = data.nom || '';
    const prenom = data.prenom || '';
    const semaine = data.semaine || '';
    const numSem = parseNumSemaine(semaine);

    // Verify SHA-256 hash when both are provided
    if (data.hash_sha256 && data.pdf_base64) {
      const computed = crypto
        .createHash('sha256')
        .update(Buffer.from(data.pdf_base64, 'base64'))
        .digest('hex');
      if (computed !== data.hash_sha256) {
        logger.warn(`Hash SHA-256 invalide pour ${nom} ${prenom} sem.${numSem}`);
      }
    }

    // Detailed PDF diagnostics
    const hasPdf = !!(data.pdf_base64);
    logger.info(`[PDF-DIAG] Champs reçus: ${Object.keys(data).join(', ')}`);
    logger.info(`[PDF-DIAG] pdf_base64 présent: ${hasPdf} | longueur: ${hasPdf ? data.pdf_base64.length : 0}`);
    if (hasPdf) {
      logger.info(`[PDF-DIAG] 50 premiers chars: ${data.pdf_base64.slice(0, 50)}`);
    }

    // Save signed PDF if provided
    let lienPdf = '';
    if (data.pdf_base64) {
      const pdfName = `feuille_${safeFilePart(nom)}_${safeFilePart(prenom)}_sem${numSem}.pdf`;
      const pdfPath = path.join(PDF_DIR, pdfName);
      logger.info(`[PDF-DIAG] Chemin cible: ${pdfPath}`);
      // Strip data URI prefix if the client included it (e.g. "data:application/pdf;base64,")
      let b64 = data.pdf_base64;
      const commaIdx = b64.indexOf(',');
      if (commaIdx !== -1 && commaIdx < 100) {
        logger.info(`[PDF-DIAG] Préfixe data URI détecté à l'index ${commaIdx} — strip effectué`);
        b64 = b64.slice(commaIdx + 1);
      } else {
        logger.info(`[PDF-DIAG] Pas de préfixe data URI (commaIdx=${commaIdx})`);
      }
      logger.info(`[PDF-DIAG] Longueur base64 après strip: ${b64.length}`);
      const pdfBuf = Buffer.from(b64, 'base64');
      logger.info(`[PDF-DIAG] Buffer décodé — byteLength: ${pdfBuf.length} | en-tête hex: ${pdfBuf.slice(0, 8).toString('hex')}`);
      if (!pdfBuf.slice(0, 4).toString().startsWith('%PDF')) {
        logger.warn(`[PDF-DIAG] En-tête invalide — attendu 25504446 (%PDF), reçu: ${pdfBuf.slice(0, 8).toString('hex')}`);
      }
      try {
        fs.writeFileSync(pdfPath, pdfBuf);
        logger.info(`[PDF-DIAG] Fichier écrit avec succès: ${pdfPath} (${pdfBuf.length} bytes)`);
        lienPdf = `./pdfs/${pdfName}`;
      } catch (writeErr) {
        logger.err(`[PDF-DIAG] ECHEC écriture fichier ${pdfPath}: ${writeErr.message}`);
      }
    } else {
      logger.warn(`[PDF-DIAG] Champ pdf_base64 absent de la requête — aucun PDF sauvegardé`);
    }

    const now = new Date();
    const horodatage = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

    // Support three payload shapes:
    //   flat   : h_lundi, panier_lundi, site_lundi, …  (top-level keys)
    //   array  : jours[0..6] with {heures, panier, site} (sent by feuille_heure_v4.html)
    //   object : jours.lundi.heures, …
    const joursKeys = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
    const joursData = {};
    for (let i = 0; i < joursKeys.length; i++) {
      const j = joursKeys[i];
      const jourItem = Array.isArray(data.jours) ? data.jours[i] : data.jours?.[j];
      joursData[`h_${j}`]      = data[`h_${j}`]      ?? jourItem?.heures  ?? 0;
      joursData[`panier_${j}`] = data[`panier_${j}`] ?? jourItem?.panier  ?? '';
      joursData[`site_${j}`]   = data[`site_${j}`]   ?? jourItem?.site    ?? '';
    }

    const row = {
      horodatage,
      entreprise:     data.entreprise  || 'DSN Transports',
      nom,
      prenom,
      telephone:      data.telephone   || '',
      semaine,
      agence:         data.agence      || 'Dom RH',
      referent:       data.referent    || '',
      total_heures:   data.total_heures  ?? 0,
      total_paniers:  data.total_paniers ?? 0,
      statut:         data.statut      || 'RECU',
      observations:   data.observations || '',
      ...joursData,
      lien_pdf:       lienPdf,
      num_document:   data.num_document  || '',
      hash_sha256:    data.hash_sha256   || '',
      timestamp_date: now.toISOString(),
    };

    // Détection doublon : même nom + prenom + semaine
    const existingRows = getSheetData(readWorkbook(), 'Feuilles');
    const nomNorm = normStr(nom);
    const prenomNorm = normStr(prenom);
    const doublonIdx = existingRows.findIndex((r) =>
      normStr(r.nom) === nomNorm &&
      normStr(r.prenom) === prenomNorm &&
      parseNumSemaine(r.semaine) === numSem
    );

    if (doublonIdx !== -1 && !data.forcer) {
      // Supprimer le PDF qu'on vient d'écrire (doublon refusé)
      if (lienPdf) {
        try { fs.unlinkSync(path.join(__dirname, '..', lienPdf.replace(/^\.\//, ''))); } catch (_) {}
      }
      return res.json({
        status: 'doublon',
        message: `Une fiche existe déjà pour ${nom} ${prenom} semaine ${numSem}. Voulez-vous la remplacer ?`,
      });
    }

    if (doublonIdx !== -1) {
      // forcer: true → supprimer l'ancien PDF et remplacer la ligne
      const ancienLien = existingRows[doublonIdx].lien_pdf;
      if (ancienLien) {
        try {
          const ancienPath = path.join(__dirname, '..', ancienLien.replace(/^\.\//, ''));
          if (fs.existsSync(ancienPath)) {
            fs.unlinkSync(ancienPath);
            logger.info(`Ancien PDF remplacé supprimé : ${ancienPath}`);
          }
        } catch (e) {
          logger.warn(`Suppression ancien PDF : ${e.message}`);
        }
      }
      const newRows = existingRows.map((r, i) => (i === doublonIdx ? row : r));
      await replaceSheet('Feuilles', newRows);
      await calcul.recalculer();
      nettoyerAnciensPdfs();
      logger.ok(`Feuille ${nom} ${prenom} sem.${numSem} REMPLACÉE`);
      return res.json({ status: 'ok', remplace: true, lien_pdf: lienPdf });
    }

    await appendRow('Feuilles', row);
    await calcul.recalculer();
    nettoyerAnciensPdfs();

    logger.ok(`Feuille ${nom} ${prenom} sem.${numSem} reçue et enregistrée`);
    res.json({ status: 'ok', lien_pdf: lienPdf });
  } catch (err) {
    logger.err(`Erreur webhook feuille-heures : ${err.message}`);
    res.status(500).json({ status: 'error', message: err.message });
  }
}

module.exports = { handleFeuille };
