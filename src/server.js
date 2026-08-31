require("dotenv").config();
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
app.listen(PORT, () => {
  console.log(`✅ Serveur SEDAP'Tech backend démarré sur http://localhost:${PORT}`);
});
