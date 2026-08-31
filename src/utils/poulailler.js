const pool = require("../db/pool");

async function obtenirPoulaillerOuvrier(ouvrierId) {
  const resultat = await pool.query(
    "SELECT id FROM poulaillers WHERE ouvrier_id = $1 LIMIT 1",
    [ouvrierId]
  );
  return resultat.rows[0]?.id || null;
}

module.exports = { obtenirPoulaillerOuvrier };
