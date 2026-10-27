const express = require("express");
const router = express.Router();
const verifierToken = require("../middleware/auth");
const exigerPoulaillerOuvert = require("../middleware/exigerPoulaillerOuvert");
const {
  listerStock,
  recevoirStock,
  listerAutresProduits,
  ajouterAutreProduit,
} = require("../controllers/stockController");

router.use(verifierToken);
// Barrage de paiement : aucune écriture tant que la facture de la
// bande en cours est verrouillée (services/verrou.js).
router.use(exigerPoulaillerOuvert);

router.get("/", listerStock);
router.post("/:produitId/reception", recevoirStock);
router.get("/autres", listerAutresProduits);
router.post("/autres", ajouterAutreProduit);

module.exports = router;
