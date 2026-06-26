#!/usr/bin/env bash
set -euo pipefail

echo "============================================"
echo "   Installation DSN Automation"
echo "============================================"

# ── Node.js ≥ 18 ─────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "❌ Node.js introuvable. Installez Node.js 18+ depuis https://nodejs.org"
  exit 1
fi
NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌ Node.js 18+ requis (version actuelle : $(node -v))"
  exit 1
fi
echo "✅ Node.js $(node -v) détecté"

# ── PM2 ───────────────────────────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  echo "Installation de PM2 (sudo npm install -g pm2)…"
  npm install -g pm2
fi
echo "✅ PM2 $(pm2 -v) détecté"

# ── Dépendances NPM ───────────────────────────────────────────────────────────
echo "Installation des dépendances Node.js…"
npm install --omit=dev
echo "✅ Dépendances installées"

# ── Dossiers de travail ───────────────────────────────────────────────────────
mkdir -p pdfs factures_entrees factures_traitees mapping_entrees mapping_traites logs
echo "✅ Dossiers créés"

# ── Démarrage PM2 ─────────────────────────────────────────────────────────────
pm2 delete dsn-automation 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

echo ""
echo "============================================"
echo "   ✅ DSN Automation démarré avec succès"
echo "============================================"
echo ""
echo "  Logs en direct  : pm2 logs dsn-automation"
echo "  Statut          : pm2 status"
echo "  Redémarrer      : pm2 restart dsn-automation"
echo "  Arrêter         : pm2 stop dsn-automation"
echo ""
echo "  Pour démarrer automatiquement au boot :"
echo "  --> exécutez la commande affichée par : pm2 startup"
echo "  --> puis relancez : pm2 save"
echo ""
echo "  Test webhook :"
echo "  curl -s -X POST http://localhost:3000/feuille-heures \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"nom\":\"LEJUSTE\",\"prenom\":\"Simon\",\"semaine\":\"2026.24\",\"total_heures\":39}'"
