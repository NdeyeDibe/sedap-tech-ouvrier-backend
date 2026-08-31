const express = require("express");
const router = express.Router();
const verifierToken = require("../middleware/auth");
const {
  listerStock,
  recevoirStock,
  listerAutresProduits,
  ajouterAutreProduit,
} = require("../controllers/stockController");

router.use(verifierToken);

router.get("/", listerStock);
router.post("/:produitId/reception", recevoirStock);
router.get("/autres", listerAutresProduits);
router.post("/autres", ajouterAutreProduit);

module.exports = router;