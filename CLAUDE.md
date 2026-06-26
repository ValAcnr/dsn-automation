# DSN Automation — Contexte projet

## Qui et quoi

PME de transport routier (**DSN Transports / AEL Services**).  
Ce serveur Node.js remplace n8n pour automatiser la gestion des intérimaires fournis par l'agence **Dom RH**.

Trois flux de données entrants :

| Source | Format | Fréquence | Dossier |
|--------|--------|-----------|---------|
| Formulaire chef d'équipe | JSON via webhook POST | À chaque fin de semaine | — |
| Facture Dom RH | PDF mensuel | 1×/mois | `./factures_entrees/` |
| Rapport géolocalisation Shiftmove/Optimum (Mapping Control) | CSV latin-1 `;` | Quotidien | `./mapping_entrees/` |

Tout converge dans un seul fichier Excel central : `feuilles_heures_interimaires.xlsx`.

---

## Architecture

```
index.js                      Express (port 3000) + démarrage des watchers chokidar
modules/
  logger.js                   fs.appendFileSync vers ./logs/dsn-YYYY-MM-DD.log
  excel.js                    xlsx read/write — queue sérialisée + retry ×3 (2 s)
  webhook.js                  POST /feuille-heures → onglet Feuilles + PDF signé
  parser-facture.js           chokidar sur factures_entrees/ → onglet Facture
  parser-mapping.js           chokidar sur mapping_entrees/ → onglet Mapping
  calcul-controles.js         recalcule l'onglet Controles après chaque import
```

Déployé avec **PM2** (`ecosystem.config.js`) pour l'autorestart.

---

## Fichier Excel — 4 onglets

### Feuilles
Colonnes : `horodatage entreprise nom prenom telephone semaine agence referent total_heures total_paniers statut observations` + par jour (`h_X panier_X site_X` pour lundi→dimanche) + `lien_pdf num_document hash_sha256 timestamp_date`

### Facture
Colonnes : `nom prenom reference semaine numero_semaine qualification heures_normales heures_feries paniers taux_horaire montant_ht agence numero_facture date_facture client`

### Mapping
Colonnes : `conducteur vehicule date numero_semaine groupe amplitude_totale km_total nb_trajets statut_vehicule`  
- `amplitude_totale` : heures décimales (converti depuis HH:MM:SS)
- `statut_vehicule` : `ACTIF` / `INACTIF` / `IMMOBILE` (0 h = IMMOBILE)

### Controles
Colonnes : `nom prenom semaine heures_signees heures_facturees ecart_facture statut_facture heures_vehicule ecart_mapping vehicule_actif statut_mapping niveau_alerte detail`

Niveaux d'alerte : `OK` / `EN ATTENTE` / `ATTENTION` / `CRITIQUE`

---

## Règles métier critiques

### Correspondance des noms (Mapping ↔ Feuilles)
Les CSV Mapping Control utilisent le format **PRENOM NOM** (parfois double espace).  
Les feuilles d'heures stockent **nom** et **prenom** séparément.  
Le matching dans `calcul-controles.js` teste les deux sens (`NOM PRENOM` et `PRENOM NOM`) après normalisation des accents et collapsing des espaces.

### Format semaine
Accepté partout : `2026.24`, `24`, `S24`, `24/2026`.  
`parseSemaine()` dans `calcul-controles.js` et `parser-mapping.js` gère tous ces formats.

### Seuils de contrôle
- Facture : écart > 0,5 h → `ALERTE` ; > 3 h → `CRITIQUE`
- Mapping GPS : écart > 1,5 h ou `IMMOBILE` → `ALERTE` ; > 3 h ou `IMMOBILE` → `CRITIQUE`

### Concurrence Excel
L'utilisateur peut avoir le fichier ouvert dans Excel. `excel.js` expose une **write queue** (Promise chain) qui sérialise toutes les écritures, avec retry ×3 × 2 s en cas d'erreur d'accès.

### Nettoyage PDFs
À chaque réception de feuille, les PDFs de plus de **5 ans** dans `./pdfs/` sont supprimés automatiquement.

---

## Dépendances NPM

| Package | Rôle |
|---------|------|
| `express` | Serveur HTTP |
| `xlsx` | Lecture/écriture fichiers `.xlsx` |
| `pdf-parse` | Extraction texte des PDFs Dom RH |
| `chokidar` | Surveillance des dossiers d'entrée |
| `iconv-lite` | Décodage latin-1 des CSV Mapping Control |

---

## Points d'attention pour les modifications futures

- **Parser facture** (`parser-facture.js`) : calé sur le format réel observé (facture n°4894, janvier 2026). Points clés : (1) 3 nombres français collés sans séparateur en fin de ligne (`7,0022,84159,88` = QTE+TAUX+MONTANT), (2) NOM tout-majuscules multi-mots + Prénom mixedCase avant `Semaine YYYY.NN`, (3) en-têtes de page strippés via `stripPageHeaders()`, (4) une ligne Excel par salarié par semaine émise au sous-total hebdo. Si Dom RH change de maquette, revoir `extract3()`, `splitNomPrenom()` et la détection du sous-total.
- **Parser mapping** (`parser-mapping.js`) : les colonnes CSV sont normalisées (accents supprimés, minuscules, underscores). Si Shiftmove/Optimum renomme des colonnes, `extractFields()` peut nécessiter un ajout.
- **Calcul contrôles** : la comparaison GPS ne vérifie pas les dates individuelles (lundi/mardi/…) mais le nombre de jours. Une vérification date à date serait plus précise mais nécessite de connaître l'année depuis le numéro de semaine.
- **Limite de taille** : le webhook accepte des payloads jusqu'à 50 MB (`express.json({ limit: '50mb' })`), suffisant pour un PDF base64 de taille normale.
- **Port** : configurable via la variable d'environnement `PORT` (défaut : 3000).
