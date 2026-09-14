const jwt = require("jsonwebtoken");

// Deux formes de jeton coexistent :
//  - l'ancienne, { ouvrierId }, émise avant l'arrivée de l'interface
//    propriétaire — encore valable 30 jours chez les testeurs ;
//  - la nouvelle, { id, role }, qui seule permet de distinguer un ouvrier
//    d'un propriétaire sur une API partagée.
// On accepte les deux et on normalise, pour ne casser aucune session.
function lireDonnees(donnees) {
  if (donnees.role) {
    return { id: donnees.id, role: donnees.role };
  }
  return { id: donnees.ouvrierId, role: "ouvrier" };
}

function verifierToken(req, res, next) {
  const enTete = req.headers.authorization;
  if (!enTete || !enTete.startsWith("Bearer ")) {
    return res.status(401).json({ erreur: "Authentification requise." });
  }

  const token = enTete.slice("Bearer ".length);
  try {
    const utilisateur = lireDonnees(jwt.verify(token, process.env.JWT_SECRET));

    if (!utilisateur.id) {
      return res.status(401).json({ erreur: "Session invalide, reconnectez-vous." });
    }

    req.utilisateur = utilisateur;

    // Conservé pour les contrôleurs ouvrier déjà écrits, qui lisent
    // req.ouvrierId. Nul si le porteur du jeton n'est pas un ouvrier :
    // une route ouvrier atteinte par un propriétaire échouera, plutôt que
    // de travailler sur un identifiant appartenant à quelqu'un d'autre.
    req.ouvrierId = utilisateur.role === "ouvrier" ? utilisateur.id : null;

    next();
  } catch (erreur) {
    return res.status(401).json({ erreur: "Session invalide ou expirée, reconnectez-vous." });
  }
}

// À placer APRÈS verifierToken sur les routes réservées à un rôle.
function exigerRole(...rolesAutorises) {
  return (req, res, next) => {
    if (!req.utilisateur || !rolesAutorises.includes(req.utilisateur.role)) {
      return res.status(403).json({ erreur: "Accès réservé." });
    }
    next();
  };
}

module.exports = verifierToken;
module.exports.verifierToken = verifierToken;
module.exports.exigerRole = exigerRole;
