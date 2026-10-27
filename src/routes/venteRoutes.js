const express = require("express");
const router = express.Router({ mergeParams: true });
const verifierToken = require("../middleware/auth");
const exigerPoulaillerOuvert = require("../middleware/exigerPoulaillerOuvert");
const verifierProprietaireBande = require("../middleware/verifierProprietaireBande");
const { ajouterVente, listerVentes, getBilan } = require("../controllers/venteController");

router.use(verifierToken);
// Barrage de paiement : aucune écriture tant que la facture de la
// bande en cours est verrouillée (services/verrou.js).
router.use(exigerPoulaillerOuvert);
router.use(verifierProprietaireBande);

router.post("/ventes", ajouterVente);
router.get("/ventes", listerVentes);
router.get("/bilan", getBilan);

module.exports = router;
