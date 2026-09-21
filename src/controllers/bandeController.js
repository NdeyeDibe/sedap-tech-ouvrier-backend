const pool = require("../db/pool");
const { obtenirPoulaillerOuvrier } = require("../utils/poulailler");
const { getSujetsRestants } = require("./venteController");

// Jour à partir duquel la vente peut s'ouvrir. Les premiers sujets atteignent
// alors leur poids ; les autres suivront sur plusieurs jours.
const JOUR_OUVERTURE_VENTE = 25;

async function creerBande(req, res) {
  const { poussinsCommandes, poussinsRecus, mortsALArrivee, souche, poidsReceptionG } = req.body;

  // Qui a payé les poussins (migration 019), comme pour une réception de
  // stock : l'ouvrier saisit alors le prix d'un poussin et la provenance ;
  // si c'est le propriétaire, les deux restent vides et c'est lui qui les
  // renseigne depuis son écran « Réceptions de stock ».
  // Une ancienne version de l'appli n'envoie pas payePar : on considère que
  // le propriétaire a payé, et le prix lui revient.
  const payePar = req.body.payePar === "ouvrier" ? "ouvrier" : "proprietaire";
  const parOuvrier = payePar === "ouvrier";
  const prixUnitairePoussin = parOuvrier ? Number(req.body.prixUnitairePoussin) : null;
  const provenance = String(req.body.provenance ?? "").trim() || null;

  // Tous les champs sont obligatoires ; seuls provenance et prix reviennent
  // au propriétaire quand c'est lui qui a payé.
  if (
    poussinsCommandes == null || poussinsCommandes === "" ||
    !poussinsRecus ||
    mortsALArrivee == null || mortsALArrivee === "" ||
    !String(souche ?? "").trim() ||
    !(Number(poidsReceptionG) > 0)
  ) {
    return res.status(400).json({
      erreur: "Commandés, reçus, morts à l'arrivée, souche et poids sont obligatoires.",
    });
  }
  if (parOuvrier && !provenance) {
    return res.status(400).json({ erreur: "La provenance est obligatoire." });
  }
  if (parOuvrier && !(prixUnitairePoussin > 0)) {
    return res.status(400).json({ erreur: "Le prix d'un poussin est obligatoire." });
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
        (poulailler_id, numero, poussins_commandes, poussins_recus, morts_a_larrivee,
         provenance, souche, poids_reception_g, poussins_paye_par, prix_unitaire_poussin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        poulaillerId, numero, poussinsCommandes, poussinsRecus, mortsALArrivee,
        provenance, String(souche).trim(), Number(poidsReceptionG), payePar, prixUnitairePoussin,
      ]
    );

    res.status(201).json(resultat.rows[0]);
  } catch (erreur) {
    if (erreur.code === "23505") {
      return res.status(409).json({
        erreur: "Une bande est déjà active pour ce poulailler. Vendez tous ses sujets avant d'en démarrer une nouvelle.",
      });
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
        (COALESCE(date_fin, now())::date - date_debut::date)::int + 1 AS jour_actuel
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
      // IMPORTANT : différence de DATES civiles (::date), pas d'heures
      // écoulées — le jour doit changer au passage de minuit, peu importe
      // l'heure exacte à laquelle la bande a été créée (ex: créée à 18h,
      // le jour doit quand même devenir "Jour 2" dès le lendemain à
      // 00h00, pas seulement 24h plus tard à 18h). Bug trouvé en test :
      // l'ancien calcul (EXTRACT(DAY FROM intervalle)) comptait des
      // périodes de 24h pleines, ce qui gardait "Jour 1" affiché toute la
      // matinée du lendemain si la bande avait été créée l'après-midi.
      //
      // La condition porte sur "pas terminée" et non sur "en_cours" : une
      // bande en phase de vente reste active. Les sujets restants meurent
      // encore et consomment toujours aliment et gaz, donc les saisies
      // quotidiennes continuent jusqu'au dernier sujet vendu.
      `SELECT *,
        (now()::date - date_debut::date)::int + 1 AS jour_actuel
       FROM bandes
       WHERE poulailler_id = $1 AND statut <> 'terminee'
       LIMIT 1`,
      [poulaillerId]
    );

    if (resultatBande.rows.length === 0) {
      return res.status(404).json({ erreur: "Aucune bande en cours." });
    }
    const bande = resultatBande.rows[0];

    const resultatMortalite = await pool.query(
      // IMPORTANT : la mortalité totale inclut morts_a_larrivee (colonne
      // de la bande elle-même, saisie à la création) EN PLUS des saisies
      // quotidiennes — sinon les morts à la réception des poussins ne
      // comptent jamais dans "sujets restants" (bug trouvé en test).
      "SELECT COALESCE(SUM(mortalite), 0) AS total FROM saisies_mortalite WHERE bande_id = $1",
      [bande.id]
    );
    const resultatVentes = await pool.query(
      "SELECT COALESCE(SUM(quantite), 0) AS total FROM ventes WHERE bande_id = $1",
      [bande.id]
    );

    const mortaliteTotale = bande.morts_a_larrivee + parseInt(resultatMortalite.rows[0].total, 10);
    const ventesTotales = parseInt(resultatVentes.rows[0].total, 10);
    const sujetsRestants = bande.poussins_recus - mortaliteTotale - ventesTotales;

    res.json({
      ...bande,
      mortalite_totale: mortaliteTotale,
      ventes_totales: ventesTotales,
      sujets_restants: sujetsRestants,
      // Dit à l'interface si le bouton « Démarrer la vente » doit s'activer.
      vente_ouvrable:
        bande.statut === "en_cours" && bande.jour_actuel >= JOUR_OUVERTURE_VENTE,
      jour_ouverture_vente: JOUR_OUVERTURE_VENTE,
    });
  } catch (erreur) {
    console.error("Erreur bande active :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

/**
 * Ouvre la phase de vente.
 *
 * Ce bouton s'appelait « Terminer la bande » et clôturait tout. C'était une
 * erreur de modèle : au jour 25, seuls quelques sujets ont le poids. Les
 * autres suivent sur plusieurs jours, pendant lesquels des sujets meurent
 * encore et ceux qui restent continuent de manger.
 *
 * La bande n'est donc pas close ici : elle entre en commercialisation. Sa
 * clôture est automatique, dès qu'il ne reste plus rien dans le poulailler —
 * un déclencheur en base s'en charge, l'ouvrier n'a pas à y penser.
 */
async function demarrerVente(req, res) {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    const poulaillerId = await obtenirPoulaillerOuvrier(req.ouvrierId);

    await client.query("BEGIN");
    await client.query("SELECT id FROM bandes WHERE id = $1 FOR UPDATE", [id]);

    const verif = await client.query(
      `SELECT statut, (now()::date - date_debut::date)::int + 1 AS jour_actuel
         FROM bandes WHERE id = $1 AND poulailler_id = $2`,
      [id, poulaillerId]
    );

    if (verif.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erreur: "Bande introuvable." });
    }

    const { statut, jour_actuel } = verif.rows[0];

    if (statut === "en_vente") {
      await client.query("ROLLBACK");
      return res.status(409).json({ erreur: "La vente est déjà ouverte sur cette bande." });
    }
    if (statut === "terminee") {
      await client.query("ROLLBACK");
      return res.status(409).json({ erreur: "Cette bande est terminée." });
    }

    if (jour_actuel < JOUR_OUVERTURE_VENTE) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        erreur: `La vente s'ouvre au jour ${JOUR_OUVERTURE_VENTE}. La bande en est au jour ${jour_actuel}.`,
      });
    }

    const resultat = await client.query(
      `UPDATE bandes
          SET statut = 'en_vente', date_debut_vente = now()
        WHERE id = $1 AND poulailler_id = $2 AND statut = 'en_cours'
        RETURNING *`,
      [id, poulaillerId]
    );

    await client.query("COMMIT");
    res.json(resultat.rows[0]);
  } catch (erreur) {
    await client.query("ROLLBACK");
    console.error("Erreur ouverture de la vente :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

/**
 * Clôture manuelle — filet de sécurité.
 *
 * Normalement inutile : la base clôt la bande dès que le poulailler est vide.
 * Reste là pour les cas où des sujets disparaissent sans passer par une vente
 * (perte, don, erreur de saisie) et où la bande ne se fermerait jamais seule.
 */
async function terminerBande(req, res) {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    const poulaillerId = await obtenirPoulaillerOuvrier(req.ouvrierId);

    await client.query("BEGIN");
    await client.query("SELECT id FROM bandes WHERE id = $1 FOR UPDATE", [id]);

    const sujetsRestants = await getSujetsRestants(id);
    if (sujetsRestants > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        erreur: `Il reste ${sujetsRestants} sujet(s) à vendre avant de pouvoir clôturer la bande.`,
      });
    }

    const resultat = await client.query(
      `UPDATE bandes SET statut = 'terminee', date_fin = now()
        WHERE id = $1 AND poulailler_id = $2 AND statut <> 'terminee'
        RETURNING *`,
      [id, poulaillerId]
    );

    if (resultat.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erreur: "Bande introuvable ou déjà terminée." });
    }

    await client.query("COMMIT");
    res.json(resultat.rows[0]);
  } catch (erreur) {
    await client.query("ROLLBACK");
    console.error("Erreur clôture bande :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

module.exports = {
  creerBande,
  listerBandes,
  bandeActive,
  demarrerVente,
  terminerBande,
  JOUR_OUVERTURE_VENTE,
};
