require("dotenv").config();
const fs = require("fs");
const https = require("https");
const express = require("express");
const cors = require("cors");
const pool = require("./db/pool");
const authRoutes = require("./routes/authRoutes");
const bandeRoutes = require("./routes/bandeRoutes");
const saisieRoutes = require("./routes/saisieRoutes");
const stockRoutes = require("./routes/stockRoutes");
const suiviRoutes = require("./routes/suiviRoutes");
const venteRoutes = require("./routes/venteRoutes");
const proprietaireAuthRoutes = require("./routes/proprietaireAuthRoutes");
const proprietaireRoutes = require("./routes/proprietaireRoutes");
const adminRoutes = require("./routes/adminRoutes");
const { listesPubliques } = require("./controllers/adminListesController");
const { demarrerSurveillance } = require("./jobs/surveillance");
const { migrer } = require("./db/migrate");
const { charger: chargerSeuils } = require("./services/seuils");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/sante", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ statut: "ok", base_de_donnees: "connectee" });
  } catch (erreur) {
    res.status(500).json({ statut: "erreur", details: erreur.message });
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/bandes", bandeRoutes);
app.use("/api/bandes/:bandeId/saisies", saisieRoutes);
app.use("/api/bandes/:bandeId", suiviRoutes);
app.use("/api/bandes/:bandeId", venteRoutes);
app.use("/api/stock", stockRoutes);

// Interface propriétaire. Préfixe distinct de /api/auth : les deux rôles
// ne s'authentifient pas de la même façon — le propriétaire n'a pas de
// pré-inscription, et s'identifie par téléphone OU e-mail.
app.use("/api/proprietaire/auth", proprietaireAuthRoutes);
app.use("/api/proprietaire", proprietaireRoutes);

// Interface admin SEDAP (ordinateur et tablette). E-mail + mot de passe,
// rôles admin et admin_principal — voir routes/adminRoutes.js.
app.use("/api/admin", adminRoutes);

// Listes de référence (couvoirs, souches, fournisseurs) : lecture libre.
// Les applis ouvrier et propriétaire les affichent dans leurs formulaires ;
// les masquées n'y figurent pas.
app.get("/api/listes", listesPubliques);

app.use((err, req, res, next) => {
  console.error("Erreur non gérée :", err);
  res.status(500).json({ erreur: "Erreur serveur inattendue." });
});

const PORT = process.env.PORT || 4000;

// HTTPS en développement local (nécessaire pour tester le micro sur un
// vrai téléphone via le réseau local, ex: https://192.168.1.19:4000 —
// les navigateurs bloquent l'accès au micro sur une connexion http
// non-localhost). Actif UNIQUEMENT si les fichiers cert.pem/key.pem
// existent (générés une fois via openssl, voir README) — sinon
// démarrage en http normal, comme avant (c'est ce qui se passera aussi
// une fois déployé chez un hébergeur, qui gère son propre HTTPS).
const CHEMIN_CERT = require("path").join(__dirname, "..", "certs", "cert.pem");
const CHEMIN_CLE = require("path").join(__dirname, "..", "certs", "key.pem");

function ecouter() {
  if (fs.existsSync(CHEMIN_CERT) && fs.existsSync(CHEMIN_CLE)) {
    const options = {
      cert: fs.readFileSync(CHEMIN_CERT),
      key: fs.readFileSync(CHEMIN_CLE),
    };
    https.createServer(options, app).listen(PORT, () => {
      console.log(`✅ Serveur SEDAP'Tech backend démarré (HTTPS) sur https://localhost:${PORT}`);
    });
  } else {
    app.listen(PORT, () => {
      console.log(`✅ Serveur SEDAP'Tech backend démarré sur http://localhost:${PORT}`);
    });
  }

  // Tâches automatiques : notifications des nouvelles alertes (toutes les
  // 15 min) et suppression des vieux vocaux (une fois par jour).
  demarrerSurveillance();
}

// Les migrations passent AVANT d'ouvrir le port.
//
// Jusqu'ici il fallait penser à lancer `npm run migrate` à la main après
// chaque déploiement. Oublié, le serveur démarrait quand même et répondait
// « Erreur serveur » sur les écrans qui touchaient aux nouvelles colonnes —
// sans que rien ne dise pourquoi. Deux migrations étaient ainsi restées en
// attente plusieurs jours (sept. 2026).
//
// Si une migration échoue, on refuse de démarrer : un serveur qui répond
// avec un schéma incomplet est plus difficile à diagnostiquer qu'un serveur
// qui ne répond pas du tout, et l'erreur exacte est dans les logs.
async function demarrer() {
  try {
    await migrer({ detaille: false });
  } catch (erreur) {
    console.error("❌ Migration impossible, le serveur ne démarre pas :");
    console.error(`   ${erreur.message}`);
    process.exit(1);
  }

  // Les seuils d'alerte vivent en base depuis la migration 023 : on les lit
  // une fois au démarrage, puis à chaque modification. Un échec ici n'est
  // pas bloquant — le service retombe sur les valeurs d'origine de SEDAP.
  await chargerSeuils();

  ecouter();
}

demarrer();
