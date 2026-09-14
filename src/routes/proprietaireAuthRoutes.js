const express = require("express");
const router = express.Router();
const {
  verifierIdentite,
  creerPin,
  connexion,
  moi,
} = require("../controllers/proprietaireAuthController");
const { verifierToken, exigerRole } = require("../middleware/auth");

// Aucune route d'inscription : SEDAP crée les comptes propriétaires.
router.post("/verifier-identite", verifierIdentite);
router.post("/creer-pin", creerPin);
router.post("/connexion", connexion);
router.get("/moi", verifierToken, exigerRole("proprietaire"), moi);

module.exports = router;
