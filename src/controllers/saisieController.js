// Contrôleur des saisies quotidiennes — CDC section V (Mortalité,
// Santé) et VII (Alimentation). Remplace lib/saisieDuJourStore.js du
// frontend (actuellement en mémoire) par de vraies données persistées.
//
// Règle CDC : une seule saisie mortalité/santé par bande et par jour
// (contrainte UNIQUE en base, voir schema.sql) — enregistrer deux fois
// le même jour MET À JOUR la saisie existante plutôt que d'en créer une
// deuxième (comportement "upsert").
const pool = require("../db/pool");

// POST /api/bandes/:bandeId/saisies/mortalite
async function enregistrerMortalite(req, res) {
  const { bandeId } = req.params;
  const { mortalite, nbPhotos } = req.body;

  if (mortalite === undefined || mortalite < 0) {
    return res.status(400).json({ erreur: "La mortalité doit être un nombre positif ou nul." });
  }
  // Règle CDC : si mortalité > 0, au moins 1 photo attendue (le
  // frontend bloque déjà ça, mais on revérifie côté serveur aussi —
  // ne jamais faire confiance uniquement à l'interface)
  if (mortalite > 0 && (!nbPhotos || nbPhotos < 1)) {
    return res.status(400).json({ erreur: "Au moins une photo est requise si mortalité > 0." });
  }

  try {
    const resultat = await pool.query(
      `INSERT INTO saisies_mortalite (bande_id, date_saisie, mortalite, nb_photos)
       VALUES ($1, CURRENT_DATE, $2, $3)
       ON CONFLICT (bande_id, date_saisie)
       DO UPDATE SET mortalite = EXCLUDED.mortalite, nb_photos = EXCLUDED.nb_photos
       RETURNING *`,
      [bandeId, mortalite, nbPhotos || 0]
    );
    res.status(201).json(resultat.rows[0]);
  } catch (erreur) {
    console.error("Erreur saisie mortalité :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// POST /api/bandes/:bandeId/saisies/sante
async function enregistrerSante(req, res) {
  const { bandeId } = req.params;
  const { etat, aVocal, aPhoto } = req.body;

  if (!["bien", "anormal", "urgent"].includes(etat)) {
    return res.status(400).json({ erreur: "État invalide (bien, anormal ou urgent attendu)." });
  }
  // CDC : si anormal/urgent, au moins une preuve (photo ET/OU vocal) requise
  if (etat !== "bien" && !aVocal && !aPhoto) {
    return res.status(400).json({ erreur: "Une preuve (photo ou vocal) est requise pour Anormal/Urgent." });
  }

  try {
    const resultat = await pool.query(
      `INSERT INTO saisies_sante (bande_id, date_saisie, etat, a_vocal, a_photo)
       VALUES ($1, CURRENT_DATE, $2, $3, $4)
       ON CONFLICT (bande_id, date_saisie)
       DO UPDATE SET etat = EXCLUDED.etat, a_vocal = EXCLUDED.a_vocal, a_photo = EXCLUDED.a_photo
       RETURNING *`,
      [bandeId, etat, aVocal || false, aPhoto || false]
    );
    res.status(201).json(resultat.rows[0]);
  } catch (erreur) {
    console.error("Erreur saisie santé :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// POST /api/bandes/:bandeId/saisies/alimentation
// Body : { lignes: [{ typeAliment, sacs, kg }, ...] } — plusieurs lignes
// possibles pour couvrir le mélange de types le même jour (décision Ndeye)
async function enregistrerAlimentation(req, res) {
  const { bandeId } = req.params;
  const { lignes } = req.body;

  if (!Array.isArray(lignes) || lignes.length === 0) {
    return res.status(400).json({ erreur: "Au moins une ligne d'aliment est requise." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // On remplace toutes les lignes du jour (plutôt que d'accumuler) —
    // évite les doublons si l'ouvrier revient corriger sa saisie du jour
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

      // Décrémente le stock correspondant (kg précis, cf décision Mengué)
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

// GET /api/bandes/:bandeId/saisie-du-jour — tout ce qui a déjà été
// saisi aujourd'hui pour cette bande (remplace saisieDuJourStore.js du
// frontend, qui gardait ça en mémoire volatile)
async function getSaisieDuJour(req, res) {
  const { bandeId } = req.params;

  try {
    const [mortalite, sante, alimentation] = await Promise.all([
      pool.query("SELECT * FROM saisies_mortalite WHERE bande_id = $1 AND date_saisie = CURRENT_DATE", [bandeId]),
      pool.query("SELECT * FROM saisies_sante WHERE bande_id = $1 AND date_saisie = CURRENT_DATE", [bandeId]),
      pool.query("SELECT * FROM saisies_alimentation WHERE bande_id = $1 AND date_saisie = CURRENT_DATE", [bandeId]),
    ]);

    res.json({
      mortalite: mortalite.rows[0] || null,
      sante: sante.rows[0] || null,
      alimentation: alimentation.rows,
      complete: mortalite.rows.length > 0 && sante.rows.length > 0 && alimentation.rows.length > 0,
    });
  } catch (erreur) {
    console.error("Erreur récupération saisie du jour :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = { enregistrerMortalite, enregistrerSante, enregistrerAlimentation, getSaisieDuJour };