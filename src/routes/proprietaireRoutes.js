const express = require("express");
const router = express.Router();
const {
  tableauDeBord,
  detailPoulailler,
  historiqueSaisies,
  photosMortalite,
  listeAlertes,
} = require("../controllers/proprietaireController");
const {
  poulaillersBilans,
  historiqueBandes,
  detailBilan,
  chargesMensuelles,
  resumeAnnuelFerme,
} = require("../controllers/proprietaireFinancesController");
const {
  registreVentes,
  enregistrerVente,
  detaillerLot,
  supprimerVente,
  supprimerDetail,
} = require("../controllers/proprietaireVentesController");
const {
  ajouterOuvrier,
  modifierOuvrier,
  retirerOuvrier,
  ajouterFrais,
  supprimerFrais,
  modifierProfil,
} = require("../controllers/proprietaireGestionController");
const { verifierToken, exigerRole } = require("../middleware/auth");

// Toutes les routes de ce fichier sont réservées au propriétaire connecté,
// et ne renvoient que les données de SA ferme.
router.use(verifierToken, exigerRole("proprietaire"));

router.get("/tableau-de-bord", tableauDeBord);
router.get("/poulaillers/:poulaillerId", detailPoulailler);

router.get("/bandes/:bandeId/saisies", historiqueSaisies);
router.get("/bandes/:bandeId/saisies/:date/photos", photosMortalite);

router.get("/alertes", listeAlertes);

// Finances
router.get("/finances/poulaillers", poulaillersBilans);
router.get("/finances/poulaillers/:poulaillerId/bandes", historiqueBandes);
router.get("/finances/bilans/:bandeId", detailBilan);
router.get("/finances/charges", chargesMensuelles);
router.get("/finances/resume-annuel", resumeAnnuelFerme);

// Ventes — le propriétaire saisit au même titre que l'ouvrier
router.get("/bandes/:bandeId/ventes", registreVentes);
router.post("/bandes/:bandeId/ventes", enregistrerVente);
router.post("/ventes/:venteId/details", detaillerLot);
router.delete("/ventes/:venteId", supprimerVente);
router.delete("/ventes/details/:detailId", supprimerDetail);

// Personnel et frais — les seules autres écritures autorisées
router.post("/personnel", ajouterOuvrier);
router.patch("/personnel/:personnelId", modifierOuvrier);
router.delete("/personnel/:personnelId", retirerOuvrier);

router.post("/frais", ajouterFrais);
router.delete("/frais/:fraisId", supprimerFrais);

router.patch("/profil", modifierProfil);

module.exports = router;
