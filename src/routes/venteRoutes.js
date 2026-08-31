const express = require("express");
const router = express.Router({ mergeParams: true });
const verifierToken = require("../middleware/auth");
const verifierProprietaireBande = require("../middleware/verifierProprietaireBande");
const { ajouterVente, listerVentes, getBilan } = require("../controllers/venteController");

router.use(verifierToken);
router.use(verifierProprietaireBande);

router.post("/ventes", ajouterVente);
router.get("/ventes", listerVentes);
router.get("/bilan", getBilan);

module.exports = router;
