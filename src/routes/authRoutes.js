const express = require("express");
const router = express.Router();
const { preInscrire, creerPin, connexion, moi } = require("../controllers/authController");
const verifierToken = require("../middleware/auth");

// TODO(INTERFACE PROPRIÉTAIRE) : /pre-inscrire tient lieu de l'interface
// propriétaire (pas encore construite) — à sécuriser/déplacer une fois
// qu'elle existera (le propriétaire seul doit pouvoir enregistrer un
// ouvrier, pas n'importe qui).
router.post("/pre-inscrire", preInscrire);
router.post("/creer-pin", creerPin);
router.post("/connexion", connexion);
router.get("/moi", verifierToken, moi);

module.exports = router;
