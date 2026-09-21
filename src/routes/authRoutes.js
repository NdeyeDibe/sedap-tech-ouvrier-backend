const express = require("express");
const router = express.Router();
const { verifierTelephone, creerPin, connexion, moi } = require("../controllers/authController");
const {
  optionsInscription,
  verifierInscription,
  optionsConnexion,
  verifierConnexion,
} = require("../controllers/webauthnController");
const verifierToken = require("../middleware/auth");

// Pas de route d'inscription : le compte de l'ouvrier responsable est créé
// par SEDAP depuis l'interface admin (POST /api/admin/poulaillers/:id/ouvrier).
// L'ancienne route publique /pre-inscrire a été supprimée.
router.get("/verifier-telephone/:telephone", verifierTelephone);
router.post("/creer-pin", creerPin);
router.post("/connexion", connexion);
router.get("/moi", verifierToken, moi);

// Face ID / empreinte digitale (WebAuthn) — inscription protégée (il
// faut déjà être connecté par PIN pour ACTIVER Face ID), connexion
// ouverte (c'est justement le but : se connecter SANS le PIN).
router.post("/webauthn/options-inscription", verifierToken, optionsInscription);
router.post("/webauthn/verifier-inscription", verifierToken, verifierInscription);
router.post("/webauthn/options-connexion", optionsConnexion);
router.post("/webauthn/verifier-connexion", verifierConnexion);

module.exports = router;