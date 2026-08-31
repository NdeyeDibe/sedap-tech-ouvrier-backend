const express = require("express");
const router = express.Router();
const verifierToken = require("../middleware/auth");
const { creerBande, listerBandes, bandeActive, terminerBande, forcerJourPourTest } = require("../controllers/bandeController");

router.use(verifierToken);

router.post("/", creerBande);
router.get("/", listerBandes);
router.get("/active", bandeActive);
router.patch("/:id/terminer", terminerBande);
router.patch("/:id/jour-test", forcerJourPourTest);

module.exports = router;
