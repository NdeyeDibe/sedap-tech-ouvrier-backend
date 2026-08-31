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