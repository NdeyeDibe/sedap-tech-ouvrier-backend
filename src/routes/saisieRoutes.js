const express = require("express");
const router = express.Router({ mergeParams: true });
const verifierToken = require("../middleware/auth");
const verifierProprietaireBande = require("../middleware/verifierProprietaireBande");
const {
  enregistrerMortalite,
  enregistrerSante,
  enregistrerAlimentation,
  marquerSansDonnee,
  getSaisieDuJour,
} = require("../controllers/saisieController");

router.use(verifierToken);
router.use(verifierProprietaireBande);

router.post("/mortalite", enregistrerMortalite);
router.post("/sante", enregistrerSante);
router.post("/alimentation", enregistrerAlimentation);
// Marque une étape comme "vue aujourd'hui, rien à déclarer" (ex :
// Alimentation sans stock disponible) — voir saisieController.marquerSansDonnee.
router.post("/:etape/sans-donnee", marquerSansDonnee);
router.get("/", getSaisieDuJour);

module.exports = router;
