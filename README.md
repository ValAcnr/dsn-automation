# DSN Automation

Serveur Node.js d'automatisation pour **DSN Transports / AEL Services**.  
Remplace n8n pour la gestion des feuilles d'heures intérimaires (Dom RH).

---

## Prérequis

| Outil | Version minimale |
|-------|-----------------|
| Node.js | 18.x |
| PM2 | dernière version (installé par `install.sh`) |
| npm | inclus avec Node.js |

---

## Installation rapide

```bash
cd dsn-automation
chmod +x install.sh
./install.sh
```

Le script :
1. Vérifie Node.js ≥ 18
2. Installe PM2 si absent
3. Lance `npm install`
4. Crée les dossiers de travail
5. Démarre le serveur via PM2

---

## Structure des dossiers

```
dsn-automation/
├── index.js                        Point d'entrée principal
├── ecosystem.config.js             Configuration PM2
├── modules/
│   ├── logger.js                   Journalisation fichier + console
│   ├── excel.js                    Lecture/écriture Excel (avec retry)
│   ├── webhook.js                  POST /feuille-heures
│   ├── parser-facture.js           Surveillance et parsing factures Dom RH
│   ├── parser-mapping.js           Surveillance et parsing CSV Mapping Control
│   └── calcul-controles.js         Recalcul de l'onglet Contrôles
├── pdfs/                           PDFs signés reçus (nettoyage auto > 5 ans)
├── factures_entrees/               Déposer les PDFs Dom RH ici
├── factures_traitees/              PDFs déplacés après traitement
├── mapping_entrees/                Déposer les CSV Shiftmove/Optimum ici
├── mapping_traites/                CSVs déplacés après traitement
├── logs/                           dsn-YYYY-MM-DD.log + logs PM2
└── feuilles_heures_interimaires.xlsx   Fichier Excel central (créé automatiquement)
```

---

## Fonctionnement

### 1. Webhook feuille d'heures

Le formulaire HTML des chefs d'équipe envoie un `POST /feuille-heures` avec le corps JSON suivant :

```json
{
  "nom": "LEJUSTE",
  "prenom": "Simon",
  "semaine": "2026.24",
  "agence": "Dom RH",
  "referent": "Marie Dupont",
  "telephone": "0601020304",
  "total_heures": 39,
  "total_paniers": 5,
  "statut": "RECU",
  "observations": "",
  "h_lundi": 8, "panier_lundi": 1, "site_lundi": "Dépôt Nord",
  "h_mardi": 8, "panier_mardi": 1, "site_mardi": "Dépôt Nord",
  "h_mercredi": 7.5,
  "h_jeudi": 8,
  "h_vendredi": 7.5,
  "h_samedi": 0,
  "h_dimanche": 0,
  "pdf_base64": "JVBERi0xLj...",
  "hash_sha256": "abc123...",
  "num_document": "FH-2026-0241"
}
```

Le payload `jours` imbriqué est également accepté (`jours.lundi.heures`, `jours.lundi.panier`, `jours.lundi.site`).

Réponse : `{ "status": "ok" }`

### 2. Factures Dom RH (PDF)

Déposez le PDF de la facture mensuelle dans `./factures_entrees/`.  
Le serveur le parse automatiquement, écrit les lignes dans l'onglet **Facture** et déplace le fichier dans `./factures_traitees/`.

Format attendu dans le PDF (une ligne par intérimaire) :
```
NOM Prenom Semaine 2026.24
CHAUFFEUR VL H/F
HN   38.50   12.50   481.25
HF    2.00   18.75    37.50
PAN   5.00    5.50    27.50
```

> **Note** : Le parser est adapté au format Dom RH décrit ci-dessus.  
> Si le format de vos factures diffère, modifiez les regex dans `modules/parser-facture.js`.

### 3. CSV Mapping Control (Shiftmove / Optimum)

Déposez le fichier CSV journalier dans `./mapping_entrees/`.  
Encodage attendu : **latin-1**, séparateur **`;`**.

Colonnes attendues (la casse et les accents sont tolérés) :
`Véhicule`, `Conducteur`, `Date`, `Groupe`, `Amplitude horaire HH:MM:SS`, `Km`

Les lignes sont agrégées par **conducteur + date** avant insertion dans l'onglet **Mapping**.

### 4. Onglet Contrôles

Recalculé automatiquement après chaque écriture dans Feuilles, Facture ou Mapping.

| Statut facture | Signification |
|---------------|---------------|
| `OK` | Écart ≤ 0,5 h |
| `ALERTE` | Écart > 0,5 h |
| `NON FACTURE` | Absent de la facture malgré une feuille signée |
| `EN ATTENTE` | Aucune facture reçue pour cette semaine |

| Statut mapping | Signification |
|---------------|---------------|
| `OK` | Écart ≤ 1,5 h, tous les jours GPS présents |
| `ALERTE` | Écart > 1,5 h ou véhicule `IMMOBILE` |
| `EN ATTENTE` | Données GPS manquantes |

| Niveau alerte | Déclencheur |
|--------------|-------------|
| `CRITIQUE` | Écart > 3 h ou `IMMOBILE` |
| `ATTENTION` | Alerte < 3 h ou non facturé |
| `EN ATTENTE` | Données manquantes |
| `OK` | Tout conforme |

---

## Gestion des erreurs Excel

Si le fichier Excel est ouvert par un utilisateur au moment d'une écriture, le serveur **réessaie 3 fois** avec 2 secondes d'attente entre chaque tentative avant de journaliser l'erreur.

---

## Logs

Les logs sont écrits dans `./logs/dsn-YYYY-MM-DD.log` et affichés en console.

```
[11/06/2026 08:45] ✅ Feuille LEJUSTE Simon sem.24 reçue et enregistrée
[11/06/2026 08:46] ✅ Contrôles recalculés : 12 ligne(s)
[11/06/2026 09:00] ℹ️ Traitement facture PDF : DOMRH_FAC-2026-024.pdf
[11/06/2026 09:00] ✅ Facture DOMRH_FAC-2026-024.pdf traitée — 34 ligne(s) importée(s)
```

---

## Commandes PM2

```bash
pm2 logs dsn-automation      # Logs en direct
pm2 status                   # État du processus
pm2 restart dsn-automation   # Redémarrer
pm2 stop dsn-automation      # Arrêter
pm2 delete dsn-automation    # Supprimer de PM2
```

---

## Test rapide

```bash
curl -s -X POST http://localhost:3000/feuille-heures \
     -H "Content-Type: application/json" \
     -d '{"nom":"LEJUSTE","prenom":"Simon","semaine":"2026.24","total_heures":39,"h_lundi":8,"h_mardi":8,"h_mercredi":7.5,"h_jeudi":8,"h_vendredi":7.5}'

# Réponse attendue : {"status":"ok"}

curl http://localhost:3000/health
# Réponse attendue : {"status":"ok","uptime":...}
```
