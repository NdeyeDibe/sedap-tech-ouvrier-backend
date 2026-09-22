const express = require("express");
const router = express.Router();
const { verifierTelephone, creerPin, connexion, moi } = require("../controllers/authController");
const verifierToken = require("../middleware/auth");

// Pas de route d'inscription : le compte de l'ouvrier responsable est créé
// par SEDAP depuis l'interface admin (POST /api/admin/poulaillers/:id/ouvrier).
// L'ancienne route publique /pre-inscrire a été supprimée.
router.get("/verifier-telephone/:telephone", verifierTelephone);
router.post("/creer-pin", creerPin);
router.post("/connexion", connexion);
router.get("/moi", verifierToken, moi);

// Face ID retiré (sept. 2026) : connexion par code PIN uniquement. La
// table credentials_webauthn reste en base, inutilisée.

module.exports = router;