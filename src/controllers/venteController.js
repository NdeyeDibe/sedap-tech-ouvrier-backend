// Contrôleur Ventes + Bilan — CDC section IX et X.
const pool = require("../db/pool");

// Calcule les sujets restants à vendre pour une bande (même logique que
// bandeController.bandeActive, dupliquée ici pour valider qu'une vente
// ne dépasse jamais ce qui reste réellement disponible).
async function getSujetsRestants(bandeId) {
  const resultatBande = await pool.query(
    "SELECT poussins_recus, morts_a_larrivee FROM bandes WHERE id = $1",
    [bandeId]
  );
  const { poussins_recus: poussinsRecus, morts_a_larrivee: mortsALArrivee } = resultatBande.rows[0];

  const resultatMortalite = await pool.query(
    "SELECT COALESCE(SUM(mortalite), 0) AS total FROM saisies_mortalite WHERE bande_id = $1",
    [bandeId]
  );
  const resultatVentes = await pool.query(
    "SELECT COALESCE(SUM(quantite), 0) AS total FROM ventes WHERE bande_id = $1",
    [bandeId]
  );

  // IMPORTANT : inclut morts_a_larrivee EN PLUS des saisies quotidiennes
  // (sinon les morts à la réception des poussins ne comptent jamais).
  const mortaliteTotale = mortsALArrivee + parseInt(resultatMortalite.rows[0].total, 10);
  const ventesTotales = parseInt(resultatVentes.rows[0].total, 10);
  return poussinsRecus - mortaliteTotale - ventesTotales;
}

// POST /api/bandes/:bandeId/ventes
// Body : { nomClient, telephoneClient?, prixUnitaire, quantite }
//
// IMPORTANT — sécurité multi-interfaces (CDC : le propriétaire pourra
// aussi vendre depuis SA propre interface, sur le même stock de sujets)
// : la vérification "assez de sujets restants ?" et l'enregistrement de
// la vente se font dans UNE SEULE transaction avec un verrou sur la
// ligne de la bande (SELECT ... FOR UPDATE). Sans ça, deux ventes
// lancées EXACTEMENT en même temps depuis deux interfaces différentes
// pourraient chacune voir "assez de stock" avant que l'autre n'ait fini
// d'enregistrer la sienne, et survendre plus de sujets qu'il n'en
// existe réellement. Avec le verrou, la deuxième vente attend
// automatiquement que la première soit terminée avant de vérifier à son
// tour — jamais de survente possible, peu importe le nombre
// d'interfaces qui vendent en parallèle.
async function ajouterVente(req, res) {
  const { bandeId } = req.params;
  const { typeVente, nomClient, telephoneClient, prixUnitaire, quantite } = req.body;
  const type = typeVente === "ramassage" ? "ramassage" : "ferme";

  if (!nomClient || !quantite || quantite <= 0) {
    return res.status(400).json({ erreur: "Nom et quantité (positive) sont requis." });
  }
  // Le prix n'est exigé QUE pour une vente à la ferme — pour un
  // ramassage, il est encore inconnu (le Propriétaire le renseignera
  // plus tard en détaillant le lot, retour Mengué sept. 2026).
  if (type === "ferme" && (!prixUnitaire || prixUnitaire <= 0)) {
    return res.status(400).json({ erreur: "Le prix unitaire (positif) est requis pour une vente à la ferme." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // FOR UPDATE : verrouille cette ligne jusqu'à COMMIT/ROLLBACK — toute
    // autre transaction qui essaierait de vendre sur la MÊME bande en
    // même temps doit attendre que celle-ci se termine.
    const resultatBande = await client.query(
      "SELECT poussins_recus, morts_a_larrivee FROM bandes WHERE id = $1 FOR UPDATE",
      [bandeId]
    );
    if (resultatBande.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erreur: "Bande introuvable." });
    }
    const { poussins_recus: poussinsRecus, morts_a_larrivee: mortsALArrivee } = resultatBande.rows[0];

    const resultatMortalite = await client.query(
      "SELECT COALESCE(SUM(mortalite), 0) AS total FROM saisies_mortalite WHERE bande_id = $1",
      [bandeId]
    );
    const resultatVentes = await client.query(
      "SELECT COALESCE(SUM(quantite), 0) AS total FROM ventes WHERE bande_id = $1",
      [bandeId]
    );
    const sujetsRestants =
      poussinsRecus -
      mortsALArrivee -
      parseInt(resultatMortalite.rows[0].total, 10) -
      parseInt(resultatVentes.rows[0].total, 10);

    if (quantite > sujetsRestants) {
      await client.query("ROLLBACK");
      return res.status(409).json({ erreur: `Dépasse le nombre de sujets restants (${sujetsRestants} max).` });
    }

    const resultat = await client.query(
      // auteur_type='ouvrier' et auteur_ouvrier_id=req.ouvrierId : cette
      // route n'est aujourd'hui appelable que par un ouvrier connecté
      // (voir verifierToken sur la route) — le jour où le Propriétaire
      // pourra aussi vendre depuis sa propre interface, ce sera un
      // endpoint distinct qui renseignera auteur_type='proprietaire' à
      // la place (retour Mengué : traçabilité de qui a fait quelle vente).
      `INSERT INTO ventes (bande_id, type_vente, nom_client, telephone_client, prix_unitaire, quantite, auteur_type, auteur_ouvrier_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'ouvrier', $7) RETURNING *`,
      [bandeId, type, nomClient.trim(), telephoneClient || null, type === "ferme" ? prixUnitaire : null, quantite, req.ouvrierId]
    );

    await client.query("COMMIT");
    res.status(201).json(resultat.rows[0]);
  } catch (erreur) {
    await client.query("ROLLBACK");
    console.error("Erreur ajout vente :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

// GET /api/bandes/:bandeId/ventes
// Renvoie l'historique complet (détail client/prix inclus) — c'est au
// FRONTEND de décider quoi afficher selon qui regarde (le CDC dit de ne
// pas montrer le détail à l'ouvrier, seulement les totaux ; le
// propriétaire, lui, voit tout). L'API renvoie la donnée brute.
async function listerVentes(req, res) {
  const { bandeId } = req.params;
  try {
    const resultat = await pool.query(
      "SELECT * FROM ventes WHERE bande_id = $1 ORDER BY date_vente DESC",
      [bandeId]
    );
    const totalVendu = resultat.rows.reduce((s, v) => s + v.quantite, 0);
    // .filter(Boolean) écarte les ventes par ramassage (prix_unitaire
    // encore NULL, pas détaillées par le Propriétaire) — sans ça, un
    // seul NaN (quantite * NaN) contamine tout le total (bug trouvé en
    // test : totalRecettes devenait "null" dès qu'un ramassage existait).
    const totalRecettes = resultat.rows.reduce((s, v) => s + v.quantite * (parseFloat(v.prix_unitaire) || 0), 0);
    const sujetsRestants = await getSujetsRestants(bandeId);

    res.json({ ventes: resultat.rows, totalVendu, totalRecettes, sujetsRestants });
  } catch (erreur) {
    console.error("Erreur liste ventes :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// GET /api/bandes/:bandeId/bilan — bilan de fin de bande (CDC section X)
async function getBilan(req, res) {
  const { bandeId } = req.params;
  try {
    const resultatBande = await pool.query(
      `SELECT *, (COALESCE(date_fin, now())::date - date_debut::date)::int + 1 AS duree_jours
       FROM bandes WHERE id = $1`,
      [bandeId]
    );
    if (resultatBande.rows.length === 0) {
      return res.status(404).json({ erreur: "Bande introuvable." });
    }
    const bande = resultatBande.rows[0];

    const resultatMortalite = await pool.query(
      "SELECT COALESCE(SUM(mortalite), 0) AS total FROM saisies_mortalite WHERE bande_id = $1",
      [bandeId]
    );
    const resultatVentes = await pool.query(
      "SELECT COALESCE(SUM(quantite), 0) AS quantite, COALESCE(SUM(quantite * prix_unitaire), 0) AS recettes FROM ventes WHERE bande_id = $1",
      [bandeId]
    );

    res.json({
      numero: bande.numero,
      statut: bande.statut,
      poussinsRecus: bande.poussins_recus,
      mortaliteTotale: bande.morts_a_larrivee + parseInt(resultatMortalite.rows[0].total, 10),
      ventesTotales: parseInt(resultatVentes.rows[0].quantite, 10),
      recettesTotales: parseFloat(resultatVentes.rows[0].recettes),
      dureeJours: bande.duree_jours,
    });
  } catch (erreur) {
    console.error("Erreur bilan :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = { ajouterVente, listerVentes, getBilan, getSujetsRestants };
