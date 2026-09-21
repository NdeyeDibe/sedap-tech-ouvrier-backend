const express = require("express");
const router = express.Router();
const {
  connexion,
  motDePasseOublie,
  reinitialiser,
  moi,
  modifierMoi,
  modifierMotDePasse,
} = require("../controllers/adminAuthController");
const { creerOuvrierResponsable } = require("../controllers/adminOuvriersController");
const { exigerAdmin } = require("../middleware/exigerAdmin");

// Interface admin — cahier admin v1.1, annexe A.
// Toutes les routes commencent par /api/admin.

// ------------------------------------------------ authentification (libre)
router.post("/auth/connexion", connexion);
router.post("/auth/mot-de-passe-oublie", motDePasseOublie);
router.post("/auth/reinitialiser", reinitialiser);

// ------------------------------------------- tout ce qui suit : admin actif
router.use(exigerAdmin);

router.get("/auth/moi", moi);
router.patch("/auth/moi", modifierMoi);
router.patch("/auth/mot-de-passe", modifierMotDePasse);

// ------------------------------------------------ ouvriers responsables
// Remplace l'ancienne route publique /api/auth/pre-inscrire.
router.post("/poulaillers/:id/ouvrier", creerOuvrierResponsable);

module.exports = router;
