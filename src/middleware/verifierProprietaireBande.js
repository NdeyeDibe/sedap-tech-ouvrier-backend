const pool = require("../db/pool");
const { obtenirPoulaillerOuvrier } = require("../utils/poulailler");

async function verifierProprietaireBande(req, res, next) {
  const { bandeId } = req.params;

  try {
    const poulaillerId = await obtenirPoulaillerOuvrier(req.ouvrierId);
    const resultat = await pool.query(
      "SELECT id FROM bandes WHERE id = $1 AND poulailler_id = $2",
      [bandeId, poulaillerId]
    );

    if (resultat.rows.length === 0) {
      return res.status(404).json({ erreur: "Bande introuvable." });
    }

    next();
  } catch (erreur) {
    console.error("Erreur vérification propriétaire bande :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = verifierProprietaireBande;
