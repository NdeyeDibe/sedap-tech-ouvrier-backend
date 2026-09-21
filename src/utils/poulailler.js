const pool = require("../db/pool");

// Le poulailler d'un ouvrier se lit dans « personnel » : le responsable en
// poste, c'est-à-dire sans date de fin de fonction. C'est la seule référence
// — un ouvrier retiré par l'admin perd son accès ici même, sans qu'aucune
// autre route ait à le vérifier.
//
// Repli sur poulaillers.ouvrier_id, et uniquement pour un poulailler sans
// ferme : une ligne personnel exige une ferme, donc les poulaillers hérités
// des tests n'en ont pas. Sans ce repli, leurs ouvriers seraient bloqués dès
// le déploiement. À supprimer quand ces poulaillers auront une ferme.
async function obtenirPoulaillerOuvrier(ouvrierId) {
  const enPoste = await pool.query(
    `SELECT poulailler_id AS id
       FROM personnel
      WHERE ouvrier_id = $1
        AND role = 'responsable'
        AND fin_fonction IS NULL
        AND poulailler_id IS NOT NULL
      LIMIT 1`,
    [ouvrierId]
  );
  if (enPoste.rows[0]) return enPoste.rows[0].id;

  const herite = await pool.query(
    `SELECT id FROM poulaillers
      WHERE ouvrier_id = $1 AND ferme_id IS NULL
      LIMIT 1`,
    [ouvrierId]
  );
  return herite.rows[0]?.id ?? null;
}

module.exports = { obtenirPoulaillerOuvrier };
