const express = require("express");
const router = express.Router();
const verifierToken = require("../middleware/auth");
const {
  creerBande,
  listerBandes,
  bandeActive,
  demarrerVente,
  terminerBande,
} = require("../controllers/bandeController");

router.use(verifierToken);

router.post("/", creerBande);
router.get("/", listerBandes);
router.get("/active", bandeActive);

// Ouvre la phase de vente au jour 25. Ne clôt pas la bande : les sujets
// restants continuent d'être suivis jusqu'au dernier vendu.
router.patch("/:id/demarrer-vente", demarrerVente);

// Clôture manuelle — filet de sécurité. La base ferme normalement la bande
// d'elle-même dès que le poulailler est vide.
router.patch("/:id/terminer", terminerBande);

module.exports = router;
