const pool = require("../db/pool");

async function enregistrerMortalite(req, res) {
  const { bandeId } = req.params;
  const { mortalite, photos } = req.body;
  const urlsPhotos = Array.isArray(photos) ? photos : [];

  if (mortalite === undefined || mortalite < 0) {
    return res.status(400).json({ erreur: "La mortalité doit être un nombre positif ou nul." });
  }
  if (mortalite > 0 && urlsPhotos.length < 1) {
    return res.status(400).json({ erreur: "Au moins une photo est requise si mortalité > 0." });
  }

  try {
    const resultat = await pool.query(
      `INSERT INTO saisies_mortalite (bande_id, date_saisie, mortalite, photos)
       VALUES ($1, CURRENT_DATE, $2, $3)
       ON CONFLICT (bande_id, date_saisie)
       DO UPDATE SET mortalite = EXCLUDED.mortalite, photos = EXCLUDED.photos
       RETURNING *`,
      [bandeId, mortalite, urlsPhotos]
    );
    res.status(201).json(resultat.rows[0]);
  } catch (erreur) {
    console.error("Erreur saisie mortalité :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

async function enregistrerSante(req, res) {
  const { bandeId } = req.params;
  const { etat, aVocal, photos } = req.body;
  const urlsPhotos = Array.isArray(photos) ? photos : [];

  // TODO(debug) : journal temporaire pour diagnostiquer un rejet 400
  // inattendu — à retirer une fois la cause trouvée.
  console.log("DEBUG saisie santé reçue :", JSON.stringify({ etat, aVocal, photos, urlsPhotos }));

  if (!["bien", "anormal", "urgent"].includes(etat)) {
    return res.status(400).json({ erreur: "État invalide (bien, anormal ou urgent attendu)." });
  }
  if (etat !== "bien" && !aVocal && urlsPhotos.length === 0) {
    return res.status(400).json({ erreur: "Une preuve (photo ou vocal) est requise pour Anormal/Urgent." });
  }

  try {
    const resultat = await pool.query(
      `INSERT INTO saisies_sante (bande_id, date_saisie, etat, a_vocal, photos)
       VALUES ($1, CURRENT_DATE, $2, $3, $4)
       ON CONFLICT (bande_id, date_saisie)
       DO UPDATE SET etat = EXCLUDED.etat, a_vocal = EXCLUDED.a_vocal, photos = EXCLUDED.photos
       RETURNING *`,
      [bandeId, etat, aVocal || false, urlsPhotos]
    );
    res.status(201).json(resultat.rows[0]);
  } catch (erreur) {
    console.error("Erreur saisie santé :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

async function enregistrerAlimentation(req, res) {
  const { bandeId } = req.params;
  const { lignes } = req.body;

  if (!Array.isArray(lignes) || lignes.length === 0) {
    return res.status(400).json({ erreur: "Au moins une ligne d'aliment est requise." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      "DELETE FROM saisies_alimentation WHERE bande_id = $1 AND date_saisie = CURRENT_DATE",
      [bandeId]
    );

    const lignesInserees = [];
    for (const ligne of lignes) {
      const resultat = await client.query(
        `INSERT INTO saisies_alimentation (bande_id, date_saisie, type_aliment, sacs, kg_supplementaires)
         VALUES ($1, CURRENT_DATE, $2, $3, $4)
         RETURNING *`,
        [bandeId, ligne.typeAliment, ligne.sacs || 0, ligne.kg || 0]
      );
      lignesInserees.push(resultat.rows[0]);

      const totalKg = (ligne.sacs || 0) * 50 + (ligne.kg || 0);
      await client.query(
        `UPDATE stock_produits SET quantite = quantite - $1
         WHERE produit_id = 'aliment' AND variante_id = $2
           AND poulailler_id = (SELECT poulailler_id FROM bandes WHERE id = $3)`,
        [totalKg, ligne.typeAliment, bandeId]
      );
    }

    await client.query("COMMIT");
    res.status(201).json(lignesInserees);
  } catch (erreur) {
    await client.query("ROLLBACK");
    console.error("Erreur saisie alimentation :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

async function getSaisieDuJour(req, res) {
  const { bandeId } = req.params;

  try {
    const [mortalite, sante, alimentation, vaccination, pesage, produitsUtilises] = await Promise.all([
      pool.query("SELECT * FROM saisies_mortalite WHERE bande_id = $1 AND date_saisie = CURRENT_DATE", [bandeId]),
      pool.query("SELECT * FROM saisies_sante WHERE bande_id = $1 AND date_saisie = CURRENT_DATE", [bandeId]),
      pool.query("SELECT * FROM saisies_alimentation WHERE bande_id = $1 AND date_saisie = CURRENT_DATE", [bandeId]),
      pool.query("SELECT * FROM vaccinations WHERE bande_id = $1 AND date_saisie = CURRENT_DATE", [bandeId]),
      pool.query("SELECT * FROM pesages WHERE bande_id = $1 AND date_saisie = CURRENT_DATE", [bandeId]),
      pool.query(
        `SELECT pu.*, sp.nom, sp.produit_id, sp.variante_id FROM produits_utilises pu
         JOIN stock_produits sp ON sp.id = pu.stock_produit_id
         WHERE pu.bande_id = $1 AND pu.date_saisie = CURRENT_DATE`,
        [bandeId]
      ),
    ]);

    res.json({
      mortalite: mortalite.rows[0] || null,
      sante: sante.rows[0] || null,
      alimentation: alimentation.rows,
      vaccination: vaccination.rows[0] || null,
      pesage: pesage.rows[0] || null,
      produitsUtilises: produitsUtilises.rows,
      complete: mortalite.rows.length > 0 && sante.rows.length > 0 && alimentation.rows.length > 0,
    });
  } catch (erreur) {
    console.error("Erreur récupération saisie du jour :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = { enregistrerMortalite, enregistrerSante, enregistrerAlimentation, getSaisieDuJour };