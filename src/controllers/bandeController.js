const pool = require("../db/pool");
const { obtenirPoulaillerOuvrier } = require("../utils/poulailler");
const { getSujetsRestants } = require("./venteController");
const { facturerOuverture } = require("../services/facturation");

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

  // Provenance et souche sont devenues facultatives (demande Ndeye et
  // Mengué, 26 oct. 2026) : au moment de la réception, le responsable ne
  // les connaît pas toujours, et les exiger le poussait à choisir
  // n'importe quelle valeur de la liste pour pouvoir avancer — une
  // donnée fausse est pire qu'une donnée vide. Elles se complètent
  // ensuite depuis la correction de bande, côté admin.
  if (
    poussinsCommandes == null || poussinsCommandes === "" ||
    !poussinsRecus ||
    mortsALArrivee == null || mortsALArrivee === "" ||
    !(Number(poidsReceptionG) > 0)
  ) {
    return res.status(400).json({
      erreur: "Commandés, reçus, morts à l'arrivée et poids sont obligatoires.",
    });
  }
  if (parOuvrier && !(prixUnitairePoussin > 0)) {
    return res.status(400).json({ erreur: "Le prix d'un poussin est obligatoire." });
  }

  try {
    const poulaillerId = await obtenirPoulaillerOuvrier(req.ouvrierId);
    if (!poulaillerId) {
      return res.status(404).json({ erreur: "Aucun poulailler associé à ce compte." });
    }

    // Plus de poussins que le bâtiment n'en tient : presque toujours une
    // faute de frappe (20 000 pour 2 000), parfois un vrai dépassement.
    // On ne tranche pas à la place du responsable — c'est lui qui a les
    // poussins devant les yeux — mais on ne le laisse pas passer sans le
    // voir : il confirme, et SEDAP est alertée sur la fiche de la ferme.
    //
    // Refuser sèchement serait pire : si c'est la capacité enregistrée
    // qui est fausse, le responsable se retrouverait bloqué avec ses
    // poussins livrés, et toutes les saisies de la bande seraient
    // perdues pour SEDAP.
    const { rows: poulaillers } = await pool.query(
      "SELECT nom, capacite, pack FROM poulaillers WHERE id = $1",
      [poulaillerId]
    );

    // Pas d'abonnement, pas de service (décision Ndeye et Mengué, 27 oct.
    // 2026). Le pack est choisi par SEDAP à la création du poulailler ;
    // s'il manque, c'est un poulailler que personne n'a vendu, et ouvrir
    // une bande dessus reviendrait à offrir le suivi sans le savoir.
    //
    // Le message vise le responsable, qui n'y est pour rien : il doit
    // comprendre qu'il faut appeler, pas qu'il a mal saisi.
    if (!poulaillers[0]?.pack) {
      return res.status(409).json({
        code: "poulailler_sans_abonnement",
        erreur:
          "Ce poulailler n'a pas d'abonnement. Préviens le propriétaire ou SEDAP " +
          "avant de démarrer la bande.",
      });
    }

    const capacite = poulaillers[0]?.capacite ?? null;
    if (
      capacite &&
      Number(poussinsRecus) > Number(capacite) &&
      req.body.depassementConfirme !== true
    ) {
      return res.status(409).json({
        code: "capacite_depassee",
        capacite: Number(capacite),
        recus: Number(poussinsRecus),
        erreur:
          `Tu as saisi ${Number(poussinsRecus)} poussins reçus, mais ce poulailler est ` +
          `enregistré pour ${Number(capacite)} sujets. Vérifie le nombre.`,
      });
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
        // Vide devient null, jamais la chaîne vide : « pas renseigné » et
        // « renseigné avec rien » doivent se distinguer dans les écrans
        // de correction comme dans les exports.
        provenance, String(souche ?? "").trim() || null,
        Number(poidsReceptionG), payePar, prixUnitairePoussin,
      ]
    );

    // La facture de la bande, émise à l'ouverture (paiement d'avance).
    //
    // Hors de la réponse et hors de toute transaction, volontairement : si
    // la facturation échoue, le responsable a quand même SA bande. Ses
    // poussins sont déjà dans le poulailler — lui refuser l'ouverture
    // ferait perdre à SEDAP toutes les saisies de la bande, pour un
    // problème de comptabilité qui ne le concerne pas. Ce qui n'est pas
    // facturé ici est rattrapé depuis l'admin (facturerBandesOubliees).
    try {
      await facturerOuverture(pool, resultat.rows[0].id);
    } catch (erreurFacture) {
      console.error(
        `Facture non émise à l'ouverture de la bande ${resultat.rows[0].id} :`,
        erreurFacture.message
      );
    }

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
