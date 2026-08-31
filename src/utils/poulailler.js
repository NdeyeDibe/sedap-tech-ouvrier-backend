// Petit utilitaire partagé : retrouve le poulailler géré par un ouvrier
// donné. Utilisé dans plusieurs contrôleurs pour vérifier qu'un ouvrier
// n'accède qu'aux données de SON propre poulailler (sécurité — un
// ouvrier ne doit jamais pouvoir lire/modifier les données d'un autre,
// même en devinant un ID dans l'URL).
const pool = require("../db/pool");

async function obtenirPoulaillerOuvrier(ouvrierId) {
  const resultat = await pool.query(
    "SELECT id FROM poulaillers WHERE ouvrier_id = $1 LIMIT 1",
    [ouvrierId]
  );
  return resultat.rows[0]?.id || null;
}

module.exports = { obtenirPoulaillerOuvrier };