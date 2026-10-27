const express = require("express");
const router = express.Router({ mergeParams: true });
const verifierToken = require("../middleware/auth");
const exigerPoulaillerOuvert = require("../middleware/exigerPoulaillerOuvert");
const verifierProprietaireBande = require("../middleware/verifierProprietaireBande");
const {
  historiqueMortalite,
  historiqueAlimentation,
  historiqueProduitsUtilises,
  historiqueJours,
} = require("../controllers/historiqueController");

router.use(verifierToken);
// Barrage de paiement : aucune écriture tant que la facture de la
// bande en cours est verrouillée (services/verrou.js).
router.use(exigerPoulaillerOuvert);
// Même garde que les autres routes de bande : on ne lit l'historique
// d'une bande que si elle appartient bien au poulailler du responsable
// connecté.
router.use(verifierProprietaireBande);

router.get("/mortalite", historiqueMortalite);
router.get("/alimentation", historiqueAlimentation);
router.get("/produits-utilises", historiqueProduitsUtilises);
router.get("/jours", historiqueJours);

module.exports = router;
