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
const {
  deverrouillerOuvrier,
  deverrouillerProprietaire,
} = require("../controllers/adminComptesController");
const {
  corrigerBande,
  corrigerSaisie,
  detailBandeAdmin,
} = require("../controllers/adminBandesController");
const { corrigerVente, supprimerVente } = require("../controllers/adminVentesController");
const { corrigerReception } = require("../controllers/adminReceptionsController");
const { tableauDeBord } = require("../controllers/adminTableauDeBordController");
const { detailFerme } = require("../controllers/adminFermesController");
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

// ------------------------------------------------------- tableau de bord
router.get("/tableau-de-bord", tableauDeBord);

// ---------------------------------------------------------------- fermes
router.get("/fermes/:id", detailFerme);

// ------------------------------------------------ ouvriers responsables
// Remplace l'ancienne route publique /api/auth/pre-inscrire.
router.post("/poulaillers/:id/ouvrier", creerOuvrierResponsable);

// --------------------------------------------------------------- bandes
// Correction des chiffres saisis par l'ouvrier (reçus, morts à l'arrivée…).
router.get("/bandes/:id", detailBandeAdmin);
router.patch("/bandes/:id", corrigerBande);
// Rattrape une faute de frappe sur une journée déjà verrouillée.
router.patch("/bandes/:id/saisies/:date", corrigerSaisie);

// ---------------------------------------------------------------- ventes
// Une vente fausse déforme le bilan : SEDAP peut la corriger ou la retirer.
router.patch("/ventes/:id", corrigerVente);
router.delete("/ventes/:id", supprimerVente);

// ------------------------------------------------------------ réceptions
// Corriger une quantité reçue ajuste aussi le stock disponible.
router.patch("/receptions/:id", corrigerReception);

// ------------------------------------------------------ comptes bloqués
// Trois mauvais PIN et le compte se verrouille : SEDAP le rouvre d'ici.
router.patch("/ouvriers/:id/deverrouiller", deverrouillerOuvrier);
router.patch("/proprietaires/:id/deverrouiller", deverrouillerProprietaire);

module.exports = router;
