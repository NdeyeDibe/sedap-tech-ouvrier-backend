const express = require("express");
const router = express.Router({ mergeParams: true }); // mergeParams : accès à :bandeId du routeur parent
const verifierToken = require("../middleware/auth");
const verifierProprietaireBande = require("../middleware/verifierProprietaireBande");
const {
  enregistrerMortalite,
  enregistrerSante,
  enregistrerAlimentation,
  getSaisieDuJour,
} = require("../controllers/saisieController");

router.use(verifierToken);
router.use(verifierProprietaireBande);

router.post("/mortalite", enregistrerMortalite);
router.post("/sante", enregistrerSante);
router.post("/alimentation", enregistrerAlimentation);
router.get("/", getSaisieDuJour);

module.exports = router;