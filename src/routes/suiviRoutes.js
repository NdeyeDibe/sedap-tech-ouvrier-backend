const express = require("express");
const router = express.Router({ mergeParams: true });
const verifierToken = require("../middleware/auth");
const verifierProprietaireBande = require("../middleware/verifierProprietaireBande");
const {
  enregistrerVaccination,
  enregistrerPesage,
  enregistrerProduitsUtilises,
} = require("../controllers/suiviController");

router.use(verifierToken);
router.use(verifierProprietaireBande);

router.post("/vaccinations", enregistrerVaccination);
router.post("/pesages", enregistrerPesage);
router.post("/produits-utilises", enregistrerProduitsUtilises);

module.exports = router;