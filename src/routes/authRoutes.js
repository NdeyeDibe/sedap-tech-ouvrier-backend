const express = require("express");
const router = express.Router();
const { inscription, connexion, moi } = require("../controllers/authController");
const verifierToken = require("../middleware/auth");

router.post("/inscription", inscription);
router.post("/connexion", connexion);
router.get("/moi", verifierToken, moi);

module.exports = router;