const express = require("express");
const router = express.Router();
const { preInscrire, verifierTelephone, creerPin, connexion, moi } = require("../controllers/authController");
const {
  optionsInscription,
  verifierInscription,
  optionsConnexion,
  verifierConnexion,
} = require("../controllers/webauthnController");
const verifierToken = require("../middleware/auth");

// TODO(INTERFACE PROPRIÉTAIRE) : /pre-inscrire tient lieu de l'interface
// propriétaire (pas encore construite) — à sécuriser/déplacer une fois
// qu'elle existera (le propriétaire seul doit pouvoir enregistrer un
// ouvrier, pas n'importe qui).
router.post("/pre-inscrire", preInscrire);
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