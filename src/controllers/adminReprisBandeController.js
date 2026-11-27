const pool = require("../db/pool");
const { parAdmin } = require("../services/journal");
const { facturerOuverture } = require("../services/facturation");

/**
 * SEDAP démarre une bande DÉJÀ COMMENCÉE.
 *
 * POURQUOI CETTE ROUTE. Une ferme n'appelle pas SEDAP le jour où ses
 * poussins arrivent : elle appelle au jour 8, au jour 12, quand la bande
 * tourne déjà. Jusqu'ici la bande ne pouvait être créée que par le
 * responsable, et toujours au jour 1 — reprendre une ferme en cours de
 * bande obligeait donc à mentir sur la date de démarrage, ce qui faussait
 * l'âge des sujets, le programme sanitaire et le bilan d'un seul coup.
 *
 * RÉSERVÉE À SEDAP, et c'est délibéré (décision Ndeye, 22 nov. 2026) :
 * créer une bande engage la facturation. Trois créateurs possibles — le
 * responsable, le propriétaire, SEDAP — auraient produit des bandes en
 * double le jour où deux personnes créent la même. Au moment d'une
 * reprise, SEDAP est de toute façon déjà là : c'est elle qui vient de
 * créer le compte du responsable.
 *
 * CE QUI SUIT TOUT SEUL. La date de démarrage étant dans le passé, le
 * responsable arrive sur le jour courant et voit les jours précédents
 * comme des journées sans saisie — le même mécanisme que pour n'importe
 * quelle bande. Ces jours-là restent à la charge de SEDAP, qui les
 * remplit depuis la fiche de la bande.
 */
async function reprendreBande(req, res) {
  const { poulaillerId } = req.params;
  const {
    jourActuel,
    poussinsCommandes,
    poussinsRecus,
    mortsALArrivee,
    souche,
    poidsReceptionG,
    motif,
  } = req.body;

  const payePar = req.body.payePar === "ouvrier" ? "ouvrier" : "proprietaire";
  const parOuvrier = payePar === "ouvrier";
  const prixUnitairePoussin = parOuvrier ? Number(req.body.prixUnitairePoussin) : null;
  const provenance = String(req.body.provenance ?? "").trim() || null;

  const jour = Number(jourActuel);
  if (!Number.isInteger(jour) || jour < 1 || jour > 60) {
    return res.status(400).json({
      erreur:
        "Le jour où en est la bande est requis, entre 1 et 60. " +
        "Au-delà de 60 jours, ce n'est plus une bande de chair en cours.",
    });
  }
  if (!motif || String(motif).trim().length < 3) {
    return res.status(400).json({ erreur: "Le motif de la reprise est requis." });
  }
  if (
    poussinsCommandes == null || poussinsCommandes === "" ||
    !poussinsRecus ||
    mortsALArrivee == null || mortsALArrivee === "" ||
    !(Number(poidsReceptionG) > 0)
  ) {
    return res.status(400).json({
      erreur: "Commandés, reçus, morts à l'arrivée et poids à la réception sont obligatoires.",
    });
  }
  if (parOuvrier && !(prixUnitairePoussin > 0)) {
    return res.status(400).json({ erreur: "Le prix d'un poussin est obligatoire." });
  }

  try {
    const { rows: poulaillers } = await pool.query(
      `SELECT pl.id, pl.nom, pl.capacite, pl.pack, f.id AS ferme_id, f.nom AS ferme
         FROM poulaillers pl JOIN fermes f ON f.id = pl.ferme_id
        WHERE pl.id = $1`,
      [poulaillerId]
    );
    const poulailler = poulaillers[0];
    if (!poulailler) {
      return res.status(404).json({ erreur: "Poulailler introuvable." });
    }

    // Même règle qu'à l'ouverture normale : pas d'abonnement, pas de
    // service. Ici le message s'adresse à SEDAP, qui peut y remédier
    // elle-même en définissant le pack sur la fiche de la ferme.
    if (!poulailler.pack) {
      return res.status(409).json({
        erreur:
          `Aucun pack n'est défini pour ${poulailler.nom}. ` +
          `Choisissez son abonnement avant d'y ouvrir une bande.`,
      });
    }

    if (
      poulailler.capacite &&
      Number(poussinsRecus) > Number(poulailler.capacite) &&
      req.body.depassementConfirme !== true
    ) {
      return res.status(409).json({
        code: "capacite_depassee",
        capacite: Number(poulailler.capacite),
        recus: Number(poussinsRecus),
        erreur:
          `${Number(poussinsRecus)} poussins reçus pour un poulailler enregistré à ` +
          `${Number(poulailler.capacite)} sujets. Vérifiez le nombre, ou la capacité du bâtiment.`,
      });
    }

    const { rows: numeros } = await pool.query(
      "SELECT COALESCE(MAX(numero), 0) + 1 AS prochain FROM bandes WHERE poulailler_id = $1",
      [poulaillerId]
    );

    // Le jour 1 est le jour de l'arrivée des poussins : une bande au jour
    // 8 a donc démarré il y a 7 jours, pas 8. L'erreur d'un jour ici
    // décalerait tout le programme sanitaire.
    const resultat = await pool.query(
      `INSERT INTO bandes
        (poulailler_id, numero, poussins_commandes, poussins_recus, morts_a_larrivee,
         provenance, souche, poids_reception_g, poussins_paye_par, prix_unitaire_poussin,
         date_debut)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_DATE - ($11::int - 1))
       RETURNING *`,
      [
        poulaillerId, numeros[0].prochain, poussinsCommandes, poussinsRecus, mortsALArrivee,
        provenance, String(souche ?? "").trim() || null,
        Number(poidsReceptionG), payePar, prixUnitairePoussin, jour,
      ]
    );
    const bande = resultat.rows[0];

    // La facture part comme à toute ouverture. Hors transaction et sans
    // bloquer : une facturation qui échoue ne doit pas priver la ferme de
    // son suivi, elle se rattrape depuis l'admin.
    try {
      await facturerOuverture(pool, bande.id);
    } catch (erreurFacture) {
      console.error(
        `Facture non émise à la reprise de la bande ${bande.id} :`,
        erreurFacture.message
      );
    }

    parAdmin(req, {
      action: "bande_reprise",
      cibleType: "bande",
      cibleId: bande.id,
      fermeId: poulailler.ferme_id,
      poulaillerId: Number(poulaillerId),
      details: {
        poulailler: poulailler.nom,
        numero: bande.numero,
        jour_a_la_reprise: jour,
        date_debut: bande.date_debut,
        poussins_recus: Number(poussinsRecus),
        motif: String(motif).trim(),
      },
    });

    res.status(201).json({
      ...bande,
      // Ce que SEDAP doit faire ensuite : les journées d'avant la reprise
      // n'existent pas et c'est à elle de les saisir. Le dire dans la
      // réponse plutôt que de laisser l'écran le deviner.
      joursARattraper: jour - 1,
    });
  } catch (erreur) {
    if (erreur.code === "23505") {
      return res.status(409).json({
        erreur:
          "Une bande est déjà en cours sur ce poulailler. Terminez-la avant d'en reprendre une.",
      });
    }
    console.error("Erreur reprise de bande :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = { reprendreBande };
