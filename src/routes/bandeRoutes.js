const express = require("express");
const router = express.Router();
const verifierToken = require("../middleware/auth");
const { creerBande, listerBandes, bandeActive, terminerBande } = require("../controllers/bandeController");

router.use(verifierToken); // toutes les routes ci-dessous nécessitent d'être connecté

router.post("/", creerBande);
router.get("/", listerBandes);
router.get("/active", bandeActive);
router.patch("/:id/terminer", terminerBande);

module.exports = router;