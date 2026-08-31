const jwt = require("jsonwebtoken");

function verifierToken(req, res, next) {
  const enTete = req.headers.authorization;
  if (!enTete || !enTete.startsWith("Bearer ")) {
    return res.status(401).json({ erreur: "Authentification requise." });
  }

  const token = enTete.slice("Bearer ".length);
  try {
    const donnees = jwt.verify(token, process.env.JWT_SECRET);
    req.ouvrierId = donnees.ouvrierId;
    next();
  } catch (erreur) {
    return res.status(401).json({ erreur: "Session invalide ou expirée, reconnectez-vous." });
  }
}

module.exports = verifierToken;
