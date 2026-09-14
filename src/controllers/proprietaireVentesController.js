const pool = require("../db/pool");

// Écritures liées aux ventes.
//
// Propriétaire et ouvrier écrivent dans le même registre, aux mêmes règles.
// Les garde-fous — vente hors phase, survente, détail dépassant le lot — sont
// tenus par la base : ces contrôleurs se contentent de traduire les erreurs
// PostgreSQL en messages lisibles, plutôt que de recopier les règles.

async function bandeAutorisee(bandeId, proprietaireId) {
  const { rows } = await pool.query(
    `SELECT b.id, b.statut
       FROM bandes b
       JOIN poulaillers pl ON pl.id = b.poulailler_id
       JOIN fermes f ON f.id = pl.ferme_id
      WHERE b.id = $1 AND f.proprietaire_id = $2`,
    [bandeId, proprietaireId]
  );
  return rows[0] ?? null;
}

// Les exceptions levées par les déclencheurs portent déjà un message clair
// en français : on le transmet plutôt que d'en inventer un autre.
function repondreErreur(res, erreur, contexte) {
  // 'P0001' = RAISE EXCEPTION ; '23514' = violation d'une contrainte CHECK
  if (erreur.code === "P0001") {
    return res.status(409).json({ erreur: erreur.message });
  }
  if (erreur.code === "23514") {
    return res.status(400).json({ erreur: "Données de vente incohérentes." });
  }

  console.error(`Erreur ${contexte} :`, erreur);
  return res.status(500).json({ erreur: "Erreur serveur." });
}

// ------------------------------------------------------ le registre

async function registreVentes(req, res) {
  const { bandeId } = req.params;

  try {
    const bande = await bandeAutorisee(bandeId, req.utilisateur.id);
    if (!bande) return res.status(404).json({ erreur: "Bande introuvable." });

    const [lots, lignes] = await Promise.all([
      // Les lots de ramassage, avec ce qui reste à leur attribuer.
      pool.query(
        `SELECT v.id, v.nom_client, v.telephone_client, v.quantite, v.date_vente,
                v.auteur_type,
                coalesce((SELECT sum(d.quantite) FROM ventes_details d
                           WHERE d.vente_id = v.id), 0) AS detaille
           FROM ventes v
          WHERE v.bande_id = $1 AND v.type_vente = 'ramassage'
          ORDER BY v.date_vente DESC`,
        [bandeId]
      ),
      // Les lignes chiffrées : ventes à la ferme et détails de ramassage.
      // Un lot brut n'en fait pas partie, il n'a pas encore de prix.
      pool.query(
        `SELECT v.id, 'ferme' AS origine, NULL::int AS lot_id,
                v.nom_client, v.telephone_client, v.quantite, v.prix_unitaire,
                v.date_vente AS date, v.auteur_type, NULL::text AS ramasseur
           FROM ventes v
          WHERE v.bande_id = $1 AND v.type_vente = 'ferme'
          UNION ALL
         SELECT d.id, 'detail', v.id,
                d.nom_client, d.telephone_client, d.quantite, d.prix_unitaire,
                d.cree_le, 'proprietaire', v.nom_client
           FROM ventes_details d
           JOIN ventes v ON v.id = d.vente_id
          WHERE v.bande_id = $1
          ORDER BY date DESC`,
        [bandeId]
      ),
    ]);

    const lotsRestants = lots.rows.map((l) => ({
      id: l.id,
      ramasseur: l.nom_client,
      telephone: l.telephone_client,
      quantite: Number(l.quantite),
      detaille: Number(l.detaille),
      reste: Number(l.quantite) - Number(l.detaille),
      date: l.date_vente,
      auteur: l.auteur_type,
    }));

    res.json({
      lots: lotsRestants,
      sujetsSansPrix: lotsRestants.reduce((t, l) => t + l.reste, 0),
      lignes: lignes.rows.map((l) => ({
        id: l.id,
        origine: l.origine,
        lotId: l.lot_id,
        client: l.nom_client,
        telephone: l.telephone_client,
        quantite: Number(l.quantite),
        prixUnitaire: Number(l.prix_unitaire),
        montant: Number(l.quantite) * Number(l.prix_unitaire),
        date: l.date,
        auteur: l.auteur_type,
        ramasseur: l.ramasseur,
      })),
    });
  } catch (erreur) {
    repondreErreur(res, erreur, "registre des ventes");
  }
}

// ------------------------------------------------- enregistrer une vente

async function enregistrerVente(req, res) {
  const { bandeId } = req.params;
  const { type, client, telephone, quantite, prixUnitaire } = req.body;

  if (!["ferme", "ramassage"].includes(type)) {
    return res.status(400).json({ erreur: "Type de vente invalide." });
  }
  if (!client || !String(client).trim()) {
    return res.status(400).json({ erreur: "Nom du client requis." });
  }
  if (!quantite || quantite <= 0) {
    return res.status(400).json({ erreur: "Quantité invalide." });
  }
  // Un ramassage part sans prix : c'est tout son intérêt. Une vente à la
  // ferme, elle, est chiffrée sur-le-champ.
  if (type === "ferme" && (prixUnitaire == null || prixUnitaire < 0)) {
    return res.status(400).json({ erreur: "Prix unitaire requis pour une vente à la ferme." });
  }

  try {
    const bande = await bandeAutorisee(bandeId, req.utilisateur.id);
    if (!bande) return res.status(404).json({ erreur: "Bande introuvable." });

    const { rows } = await pool.query(
      `INSERT INTO ventes
         (bande_id, type_vente, nom_client, telephone_client, quantite,
          prix_unitaire, auteur_type, auteur_proprietaire_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'proprietaire', $7)
       RETURNING id, date_vente`,
      [
        bandeId,
        type,
        String(client).trim(),
        telephone || null,
        quantite,
        type === "ramassage" ? null : prixUnitaire,
        req.utilisateur.id,
      ]
    );

    res.status(201).json({ id: rows[0].id, date: rows[0].date_vente });
  } catch (erreur) {
    repondreErreur(res, erreur, "enregistrement d'une vente");
  }
}

// ------------------------------------------- détailler un ramassage

async function detaillerLot(req, res) {
  const { venteId } = req.params;
  const { client, telephone, quantite, prixUnitaire } = req.body;

  if (!client || !String(client).trim()) {
    return res.status(400).json({ erreur: "Nom de l'acheteur requis." });
  }
  if (!quantite || quantite <= 0) {
    return res.status(400).json({ erreur: "Quantité invalide." });
  }
  if (prixUnitaire == null || prixUnitaire < 0) {
    return res.status(400).json({ erreur: "Prix unitaire requis." });
  }

  try {
    // Le lot doit appartenir à une bande de sa ferme.
    const { rows: lot } = await pool.query(
      `SELECT v.id
         FROM ventes v
         JOIN bandes b ON b.id = v.bande_id
         JOIN poulaillers pl ON pl.id = b.poulailler_id
         JOIN fermes f ON f.id = pl.ferme_id
        WHERE v.id = $1 AND f.proprietaire_id = $2`,
      [venteId, req.utilisateur.id]
    );

    if (lot.length === 0) {
      return res.status(404).json({ erreur: "Ramassage introuvable." });
    }

    const { rows } = await pool.query(
      `INSERT INTO ventes_details
         (vente_id, nom_client, telephone_client, quantite, prix_unitaire, saisi_par)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, cree_le`,
      [
        venteId,
        String(client).trim(),
        telephone || null,
        quantite,
        prixUnitaire,
        req.utilisateur.id,
      ]
    );

    res.status(201).json({ id: rows[0].id, date: rows[0].cree_le });
  } catch (erreur) {
    repondreErreur(res, erreur, "détail d'un ramassage");
  }
}

// ------------------------------------------------------- suppressions

// Chacun ne supprime que ses propres saisies : la clause sur auteur_type
// suffit, une vente d'ouvrier ne correspondra jamais.
async function supprimerVente(req, res) {
  const { venteId } = req.params;

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ventes v
        USING bandes b, poulaillers pl, fermes f
        WHERE v.id = $1
          AND b.id = v.bande_id AND pl.id = b.poulailler_id AND f.id = pl.ferme_id
          AND f.proprietaire_id = $2
          AND v.auteur_type = 'proprietaire'`,
      [venteId, req.utilisateur.id]
    );

    if (rowCount === 0) {
      return res.status(404).json({
        erreur: "Vente introuvable, ou saisie par l'ouvrier.",
      });
    }

    res.status(204).end();
  } catch (erreur) {
    repondreErreur(res, erreur, "suppression d'une vente");
  }
}

async function supprimerDetail(req, res) {
  const { detailId } = req.params;

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ventes_details d
        USING ventes v, bandes b, poulaillers pl, fermes f
        WHERE d.id = $1
          AND v.id = d.vente_id AND b.id = v.bande_id
          AND pl.id = b.poulailler_id AND f.id = pl.ferme_id
          AND f.proprietaire_id = $2
          AND d.saisi_par = $2`,
      [detailId, req.utilisateur.id]
    );

    if (rowCount === 0) {
      return res.status(404).json({ erreur: "Ligne introuvable." });
    }

    res.status(204).end();
  } catch (erreur) {
    repondreErreur(res, erreur, "suppression d'un détail");
  }
}

module.exports = {
  registreVentes,
  enregistrerVente,
  detaillerLot,
  supprimerVente,
  supprimerDetail,
};
