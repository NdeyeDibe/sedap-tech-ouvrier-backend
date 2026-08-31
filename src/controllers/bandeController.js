const pool = require("../db/pool");
const { obtenirPoulaillerOuvrier } = require("../utils/poulailler");
const { getSujetsRestants } = require("./venteController");

async function creerBande(req, res) {
  const { poussinsCommandes, poussinsRecus, mortsALArrivee, provenance, souche, poidsReceptionG } = req.body;

  if (!poussinsRecus || !provenance) {
    return res.status(400).json({ erreur: "Poussins reçus et provenance sont obligatoires." });
  }

  try {
    const poulaillerId = await obtenirPoulaillerOuvrier(req.ouvrierId);
    if (!poulaillerId) {
      return res.status(404).json({ erreur: "Aucun poulailler associé à ce compte." });
    }

    const resultatNumero = await pool.query(
      "SELECT COALESCE(MAX(numero), 0) + 1 AS prochain_numero FROM bandes WHERE poulailler_id = $1",
      [poulaillerId]
    );
    const numero = resultatNumero.rows[0].prochain_numero;

    const resultat = await pool.query(
      `INSERT INTO bandes
        (poulailler_id, numero, poussins_commandes, poussins_recus, morts_a_larrivee, provenance, souche, poids_reception_g)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [poulaillerId, numero, poussinsCommandes || null, poussinsRecus, mortsALArrivee || 0, provenance, souche || null, poidsReceptionG || null]
    );

    res.status(201).json(resultat.rows[0]);
  } catch (erreur) {
    if (erreur.code === "23505") {
      return res.status(409).json({ erreur: "Une bande est déjà en cours pour ce poulailler. Terminez-la avant d'en créer une nouvelle." });
    }
    console.error("Erreur création bande :", erreur);
    res.status(500).json({ erreur: "Erreur serveur pendant la création de la bande." });
  }
}

async function listerBandes(req, res) {
  try {
    const poulaillerId = await obtenirPoulaillerOuvrier(req.ouvrierId);
    if (!poulaillerId) {
      return res.status(404).json({ erreur: "Aucun poulailler associé à ce compte." });
    }

    const resultat = await pool.query(
      `SELECT *,
        EXTRACT(DAY FROM COALESCE(date_fin, now()) - date_debut)::int + 1 AS jour_actuel
       FROM bandes
       WHERE poulailler_id = $1
       ORDER BY numero DESC`,
      [poulaillerId]
    );

    res.json(resultat.rows);
  } catch (erreur) {
    console.error("Erreur liste bandes :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

async function bandeActive(req, res) {
  try {
    const poulaillerId = await obtenirPoulaillerOuvrier(req.ouvrierId);
    if (!poulaillerId) {
      return res.status(404).json({ erreur: "Aucun poulailler associé à ce compte." });
    }

    const resultatBande = await pool.query(
      `SELECT *,
        EXTRACT(DAY FROM now() - date_debut)::int + 1 AS jour_actuel
       FROM bandes
       WHERE poulailler_id = $1 AND statut = 'en_cours'
       LIMIT 1`,
      [poulaillerId]
    );

    if (resultatBande.rows.length === 0) {
      return res.status(404).json({ erreur: "Aucune bande en cours." });
    }
    const bande = resultatBande.rows[0];

    const resultatMortalite = await pool.query(
      "SELECT COALESCE(SUM(mortalite), 0) AS total FROM saisies_mortalite WHERE bande_id = $1",
      [bande.id]
    );
    const resultatVentes = await pool.query(
      "SELECT COALESCE(SUM(quantite), 0) AS total FROM ventes WHERE bande_id = $1",
      [bande.id]
    );

    const mortaliteTotale = parseInt(resultatMortalite.rows[0].total, 10);
    const ventesTotales = parseInt(resultatVentes.rows[0].total, 10);
    const sujetsRestants = bande.poussins_recus - mortaliteTotale - ventesTotales;

    res.json({ ...bande, mortalite_totale: mortaliteTotale, ventes_totales: ventesTotales, sujets_restants: sujetsRestants });
  } catch (erreur) {
    console.error("Erreur bande active :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

async function terminerBande(req, res) {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    const poulaillerId = await obtenirPoulaillerOuvrier(req.ouvrierId);

    await client.query("BEGIN");

    // Même verrou que ajouterVente (venteController.js) sur la ligne de
    // la bande — empêche qu'une vente lancée EXACTEMENT en même temps
    // (depuis l'ouvrier ou depuis la future interface propriétaire)
    // passe entre la vérification et la clôture, ce qui laisserait des
    // sujets non vendus sur une bande pourtant marquée "terminée".
    await client.query("SELECT id FROM bandes WHERE id = $1 FOR UPDATE", [id]);

    // CDC IX.2 : clôture définitive possible SEULEMENT si tous les
    // sujets ont été vendus (sujets_à_vendre = 0) — revérifié ici côté
    // serveur, pas seulement côté interface.
    const sujetsRestants = await getSujetsRestants(id);
    if (sujetsRestants > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ erreur: `Il reste ${sujetsRestants} sujet(s) à vendre avant de pouvoir clôturer la bande.` });
    }

    const resultat = await client.query(
      `UPDATE bandes SET statut = 'terminee', date_fin = now()
       WHERE id = $1 AND poulailler_id = $2 AND statut = 'en_cours'
       RETURNING *`,
      [id, poulaillerId]
    );

    if (resultat.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erreur: "Bande introuvable ou déjà terminée." });
    }

    res.json(resultat.rows[0]);
  } catch (erreur) {
    console.error("Erreur clôture bande :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = { creerBande, listerBandes, bandeActive, terminerBande };