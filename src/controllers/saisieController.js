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
  // vocalUrl : adresse Cloudinary du message vocal. Avant, seul le booléen
  // aVocal arrivait ici : le fichier restait sur le téléphone de l'ouvrier,
  // derrière une adresse temporaire du navigateur, et le propriétaire voyait
  // qu'un vocal existait sans jamais pouvoir l'écouter.
  const { etat, aVocal, vocalUrl, photos } = req.body;
  const urlsPhotos = Array.isArray(photos) ? photos : [];

  if (!["bien", "anormal", "urgent"].includes(etat)) {
    return res.status(400).json({ erreur: "État invalide (bien, anormal ou urgent attendu)." });
  }
  if (etat !== "bien" && !aVocal && urlsPhotos.length === 0) {
    return res.status(400).json({ erreur: "Une preuve (photo ou vocal) est requise pour Anormal/Urgent." });
  }

  try {
    const resultat = await pool.query(
      `INSERT INTO saisies_sante (bande_id, date_saisie, etat, a_vocal, vocal_url, photos)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5)
       ON CONFLICT (bande_id, date_saisie)
       DO UPDATE SET etat = EXCLUDED.etat,
                     a_vocal = EXCLUDED.a_vocal,
                     vocal_url = EXCLUDED.vocal_url,
                     photos = EXCLUDED.photos
       RETURNING *`,
      [bandeId, etat, aVocal || false, vocalUrl || null, urlsPhotos]
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

    // Remet en stock ce qui avait été déduit par une éventuelle saisie
    // déjà faite aujourd'hui, AVANT de la supprimer — sinon, modifier une
    // alimentation déjà déclarée le même jour (carte "Aliment" cliquée
    // depuis le Dashboard pour corriger) déduirait le stock une seconde
    // fois pour la même quantité de départ (retour Mengué : la
    // modification doit être possible tant que la journée n'est pas
    // passée, sans fausser le stock).
    const ancienneSaisie = await client.query(
      "SELECT type_aliment, sacs, kg_supplementaires FROM saisies_alimentation WHERE bande_id = $1 AND date_saisie = CURRENT_DATE",
      [bandeId]
    );
    for (const ancienne of ancienneSaisie.rows) {
      const totalKgAncien = parseFloat(ancienne.sacs) * 50 + parseFloat(ancienne.kg_supplementaires);
      await client.query(
        `UPDATE stock_produits SET quantite = quantite + $1
         WHERE produit_id = 'aliment' AND variante_id = $2
           AND poulailler_id = (SELECT poulailler_id FROM bandes WHERE id = $3)`,
        [totalKgAncien, ancienne.type_aliment, bandeId]
      );
    }

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

// Marque une étape de la saisie du jour comme "vue aujourd'hui, rien à
// déclarer" (ex: Alimentation quand il n'y a aucun stock disponible).
// Sans ça, tant qu'aucune vraie ligne n'est enregistrée, le dashboard
// considérait la journée comme "pas encore faite" et renvoyait l'ouvrier
// en boucle sur cet écran à chaque "Continuer la saisie du jour" (retour
// terrain Mengué). ON CONFLICT DO NOTHING : rejouable sans erreur si
// l'ouvrier repasse plusieurs fois par cet écran le même jour.
async function marquerSansDonnee(req, res) {
  const { bandeId, etape } = req.params;
  const etapesAutorisees = ["alimentation"];

  if (!etapesAutorisees.includes(etape)) {
    return res.status(400).json({ erreur: "Étape invalide." });
  }

  try {
    await pool.query(
      `INSERT INTO saisies_sans_donnee (bande_id, date_saisie, etape)
       VALUES ($1, CURRENT_DATE, $2)
       ON CONFLICT (bande_id, date_saisie, etape) DO NOTHING`,
      [bandeId, etape]
    );
    res.status(201).json({ ok: true });
  } catch (erreur) {
    console.error("Erreur marquage sans-donnée :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

async function getSaisieDuJour(req, res) {
  const { bandeId } = req.params;

  try {
    const [mortalite, sante, alimentation, vaccination, pesage, produitsUtilises, sansDonnee] = await Promise.all([
      pool.query("SELECT * FROM saisies_mortalite WHERE bande_id = $1 AND date_saisie = CURRENT_DATE", [bandeId]),
      pool.query("SELECT * FROM saisies_sante WHERE bande_id = $1 AND date_saisie = CURRENT_DATE", [bandeId]),
      pool.query("SELECT * FROM saisies_alimentation WHERE bande_id = $1 AND date_saisie = CURRENT_DATE", [bandeId]),
      pool.query("SELECT * FROM vaccinations WHERE bande_id = $1 AND date_saisie = CURRENT_DATE", [bandeId]),
      pool.query("SELECT * FROM pesages WHERE bande_id = $1 AND date_saisie = CURRENT_DATE", [bandeId]),
      pool.query(
        // LEFT JOIN sur les 2 tables possibles (produit standard OU
        // "Autre") — COALESCE prend celui qui n'est pas NULL. Avant,
        // un JOIN simple sur stock_produits excluait purement et
        // simplement toute ligne "Autre" de cet écran (bug trouvé en
        // test par Ndeye).
        `SELECT pu.*, COALESCE(sp.nom, sap.nom) AS nom, sp.produit_id, sp.variante_id
         FROM produits_utilises pu
         LEFT JOIN stock_produits sp ON sp.id = pu.stock_produit_id
         LEFT JOIN stock_autres_produits sap ON sap.id = pu.stock_autre_produit_id
         WHERE pu.bande_id = $1 AND pu.date_saisie = CURRENT_DATE`,
        [bandeId]
      ),
      pool.query("SELECT etape FROM saisies_sans_donnee WHERE bande_id = $1 AND date_saisie = CURRENT_DATE", [bandeId]),
    ]);

    const etapesSansDonnee = sansDonnee.rows.map((r) => r.etape);
    const alimentationFaite = alimentation.rows.length > 0 || etapesSansDonnee.includes("alimentation");

    res.json({
      mortalite: mortalite.rows[0] || null,
      sante: sante.rows[0] || null,
      alimentation: alimentation.rows,
      alimentationSansStock: etapesSansDonnee.includes("alimentation"),
      vaccination: vaccination.rows[0] || null,
      pesage: pesage.rows[0] || null,
      produitsUtilises: produitsUtilises.rows,
      complete: mortalite.rows.length > 0 && sante.rows.length > 0 && alimentationFaite,
    });
  } catch (erreur) {
    console.error("Erreur récupération saisie du jour :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = {
  enregistrerMortalite,
  enregistrerSante,
  enregistrerAlimentation,
  marquerSansDonnee,
  getSaisieDuJour,
};
