const express = require("express");
const router = express.Router({ mergeParams: true });
const verifierToken = require("../middleware/auth");
const exigerPoulaillerOuvert = require("../middleware/exigerPoulaillerOuvert");
const verifierProprietaireBande = require("../middleware/verifierProprietaireBande");
const {
  enregistrerMortalite,
  enregistrerSante,
  enregistrerAlimentation,
  marquerSansDonnee,
  getSaisieDuJour,
} = require("../controllers/saisieController");

router.use(verifierToken);
// Barrage de paiement : aucune écriture tant que la facture de la
// bande en cours est verrouillée (services/verrou.js).
router.use(exigerPoulaillerOuvert);
router.use(verifierProprietaireBande);

router.post("/mortalite", enregistrerMortalite);
router.post("/sante", enregistrerSante);
router.post("/alimentation", enregistrerAlimentation);
// Marque une étape comme "vue aujourd'hui, rien à déclarer" (ex :
// Alimentation sans stock disponible) — voir saisieController.marquerSansDonnee.
router.post("/:etape/sans-donnee", marquerSansDonnee);
router.get("/", getSaisieDuJour);

module.exports = router;
