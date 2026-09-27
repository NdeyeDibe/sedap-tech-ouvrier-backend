const pool = require("../db/pool");
const { parAdmin, differences } = require("../services/journal");

// Correction d'une bande par SEDAP — cahier admin, section « corrections ».
//
// Pourquoi cet écran existe : l'ouvrier saisit les poussins à la création de
// la bande, une seule fois, et plus rien n'est rattrapable ensuite. Un
// retour terrain (sept. 2026) : reçus et morts à l'arrivée intervertis, et
// la bande se retrouve avec 4 sujets vivants au lieu de plusieurs centaines.
// Tout le suivi devient faux — effectifs, mortalité, bilan — sans aucun
// moyen de revenir en arrière autrement qu'en base de production.
//
// Deux règles qui tiennent tout :
//
//  1. Rien ne passe en silence. Chaque correction est inscrite au journal
//     avec l'ancienne ET la nouvelle valeur, et le propriétaire la voit sur
//     sa bande. Corriger les chiffres d'argent de quelqu'un sans le lui dire
//     est le meilleur moyen de lui faire perdre confiance dans l'appli.
//
//  2. On refuse plutôt que de casser. L'effectif de départ (reçus − morts à
//     l'arrivée) doit rester au moins égal à ce qui est déjà mort et vendu,
//     sinon effectif_restant() devient négatif et tous les écrans mentent.

// Les champs corrigeables. Tout le reste (numéro, poulailler, dates,
// statut) relève d'autres actions, avec leurs propres règles.
const CHAMPS = [
  "poussins_commandes",
  "poussins_recus",
  "morts_a_larrivee",
  "provenance",
  "souche",
  "poids_reception_g",
  "poussins_paye_par",
  "prix_unitaire_poussin",
];

// Nom lisible, pour les messages d'erreur et pour la ligne que verra le
// propriétaire.
const LIBELLES = {
  poussins_commandes: "Poussins commandés",
  poussins_recus: "Poussins reçus",
  morts_a_larrivee: "Morts à l'arrivée",
  provenance: "Provenance",
  souche: "Souche",
  poids_reception_g: "Poids à la réception",
  poussins_paye_par: "Poussins payés par",
  prix_unitaire_poussin: "Prix d'un poussin",
};

// Corps de requête (camelCase) -> colonne.
const DEPUIS_CORPS = {
  poussinsCommandes: "poussins_commandes",
  poussinsRecus: "poussins_recus",
  mortsALArrivee: "morts_a_larrivee",
  provenance: "provenance",
  souche: "souche",
  poidsReceptionG: "poids_reception_g",
  payePar: "poussins_paye_par",
  prixUnitairePoussin: "prix_unitaire_poussin",
};

// Un entier, ou null si la valeur n'est pas exploitable. Les champs
// arrivent du formulaire en chaîne de caractères.
// Absent (undefined) et vide comptent comme « pas de valeur ». Sans le test
// sur undefined, String(undefined) vaut la chaîne "undefined", non vide :
// le contrôle du motif obligatoire passait alors qu'il n'y en avait aucun.
const vide = (valeur) => valeur === null || valeur === undefined || valeur === "";

function entier(valeur) {
  if (vide(valeur)) return null;
  const n = Number(valeur);
  return Number.isInteger(n) ? n : undefined; // undefined = invalide
}

function decimal(valeur) {
  if (vide(valeur)) return null;
  const n = Number(valeur);
  return Number.isFinite(n) ? n : undefined;
}

function texte(valeur) {
  if (vide(valeur)) return null;
  const t = String(valeur).trim();
  return t === "" ? null : t;
}

// Applique le corps de la requête sur la ligne existante. Ne touche qu'aux
// champs réellement envoyés : un écran qui ne montre que deux champs ne doit
// pas effacer les six autres.
function fusionner(bande, corps) {
  const apres = {};
  for (const champ of CHAMPS) apres[champ] = bande[champ];

  for (const [cle, colonne] of Object.entries(DEPUIS_CORPS)) {
    if (!(cle in corps)) continue;
    const brut = corps[cle];

    if (colonne === "prix_unitaire_poussin") apres[colonne] = decimal(brut);
    else if (colonne === "provenance" || colonne === "souche" || colonne === "poussins_paye_par")
      apres[colonne] = texte(brut);
    else apres[colonne] = entier(brut);
  }
  return apres;
}

// Renvoie le message d'erreur, ou null si tout est cohérent.
// `deja` = ce qui est déjà mort et vendu sur cette bande.
function verifier(apres, deja) {
  for (const [colonne, valeur] of Object.entries(apres)) {
    if (valeur === undefined) return `${LIBELLES[colonne]} : valeur invalide.`;
  }

  const { poussins_recus: recus, morts_a_larrivee: morts, poussins_commandes: commandes } = apres;

  if (recus === null || recus <= 0) return "Poussins reçus : un nombre supérieur à 0 est attendu.";
  if (morts === null || morts < 0) return "Morts à l'arrivée : un nombre positif ou nul est attendu.";
  if (morts > recus) {
    return `Morts à l'arrivée (${morts}) ne peut pas dépasser les poussins reçus (${recus}).`;
  }
  if (commandes !== null && commandes < 0) {
    return "Poussins commandés : un nombre positif est attendu.";
  }
  if (apres.poids_reception_g !== null && apres.poids_reception_g <= 0) {
    return "Poids à la réception : un nombre de grammes supérieur à 0 est attendu.";
  }
  if (!["ouvrier", "proprietaire"].includes(apres.poussins_paye_par)) {
    return "Poussins payés par : « ouvrier » ou « proprietaire » attendu.";
  }
  if (apres.prix_unitaire_poussin !== null && apres.prix_unitaire_poussin <= 0) {
    return "Prix d'un poussin : un montant supérieur à 0 est attendu.";
  }
  // Même règle qu'à la création (contrainte poussins_prix_si_ouvrier).
  if (apres.poussins_paye_par === "ouvrier" && apres.prix_unitaire_poussin === null) {
    return "Le prix d'un poussin est obligatoire quand c'est l'ouvrier qui a payé.";
  }

  // LA règle : l'effectif de départ doit couvrir ce qui est déjà sorti.
  const depart = recus - morts;
  if (depart < deja.morts + deja.vendus) {
    return (
      `Impossible : cette bande a déjà ${deja.morts} morts et ${deja.vendus} vendus, ` +
      `soit ${deja.morts + deja.vendus} sujets. Avec ${recus} reçus et ${morts} morts à ` +
      `l'arrivée, l'effectif de départ ne serait que de ${depart}. Corrigez d'abord les ` +
      `saisies de mortalité ou les ventes.`
    );
  }

  return null;
}

// PATCH /api/admin/bandes/:id
async function corrigerBande(req, res) {
  const bandeId = Number(req.params.id);
  if (!Number.isInteger(bandeId)) {
    return res.status(400).json({ erreur: "Identifiant de bande invalide." });
  }

  const motif = texte(req.body.motif);
  if (!motif) {
    // Une correction sans raison écrite n'est pas exploitable six mois plus
    // tard, ni par SEDAP ni par le propriétaire qui la découvre.
    return res.status(400).json({ erreur: "Indiquez la raison de la correction." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT b.id, b.numero, b.poulailler_id,
              ${CHAMPS.join(", ")},
              sujets_morts(b.id) AS deja_morts,
              sujets_vendus(b.id) AS deja_vendus
         FROM bandes b
        WHERE b.id = $1
          FOR UPDATE`,
      [bandeId]
    );
    const bande = rows[0];
    if (!bande) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erreur: "Bande introuvable." });
    }

    const apres = fusionner(bande, req.body);
    const probleme = verifier(apres, {
      morts: Number(bande.deja_morts),
      vendus: Number(bande.deja_vendus),
    });
    if (probleme) {
      await client.query("ROLLBACK");
      return res.status(409).json({ erreur: probleme });
    }

    const diff = differences(bande, apres, CHAMPS);
    if (Object.keys(diff).length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ erreur: "Aucune modification : les valeurs sont identiques." });
    }

    await client.query(
      `UPDATE bandes SET
         poussins_commandes = $2, poussins_recus = $3, morts_a_larrivee = $4,
         provenance = $5, souche = $6, poids_reception_g = $7,
         poussins_paye_par = $8, prix_unitaire_poussin = $9
       WHERE id = $1`,
      [
        bandeId,
        apres.poussins_commandes,
        apres.poussins_recus,
        apres.morts_a_larrivee,
        apres.provenance,
        apres.souche,
        apres.poids_reception_g,
        apres.poussins_paye_par,
        apres.prix_unitaire_poussin,
      ]
    );

    await client.query("COMMIT");

    // Après le COMMIT : le journal ne fait jamais échouer l'action.
    parAdmin(req, {
      action: "bande_corrigee",
      cibleType: "bande",
      cibleId: bandeId,
      bandeId,
      details: {
        motif,
        // Libellés inclus : l'écran du propriétaire affiche la ligne sans
        // avoir à connaître les noms de colonnes.
        champs: Object.fromEntries(
          Object.entries(diff).map(([colonne, valeurs]) => [
            colonne,
            { libelle: LIBELLES[colonne], ...valeurs },
          ])
        ),
      },
    });

    // L'état recalculé, pour que l'écran affiche tout de suite le résultat.
    const { rows: etats } = await pool.query(
      `SELECT effectif_initial, morts, vendus, restant, taux_mortalite
         FROM etat_bandes WHERE bande_id = $1`,
      [bandeId]
    );

    const e = etats[0];
    res.json({
      id: bandeId,
      numero: bande.numero,
      corrections: Object.keys(diff).length,
      // NUMERIC revient de PostgreSQL en chaîne : on le rend en nombre, pour
      // que l'écran n'ait pas à y penser.
      etat: e
        ? {
            effectifInitial: e.effectif_initial,
            morts: e.morts,
            vendus: e.vendus,
            restant: e.restant,
            tauxMortalite: e.taux_mortalite == null ? 0 : Number(e.taux_mortalite),
          }
        : null,
    });
  } catch (erreur) {
    await client.query("ROLLBACK");
    console.error("Erreur correction bande :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

// GET /api/admin/bandes/:id — ce que l'écran de correction a besoin
// d'afficher : les valeurs actuelles, ce qui est déjà sorti (la limite à ne
// pas franchir), et l'historique des corrections déjà faites.
async function detailBandeAdmin(req, res) {
  const bandeId = Number(req.params.id);
  if (!Number.isInteger(bandeId)) {
    return res.status(400).json({ erreur: "Identifiant de bande invalide." });
  }

  try {
    const [{ rows: bandes }, { rows: corrections }] = await Promise.all([
      pool.query(
        `SELECT b.id, b.numero, b.statut, b.date_debut, b.date_fin,
                ${CHAMPS.join(", ")},
                pl.id AS poulailler_id, pl.nom AS poulailler_nom,
                f.id AS ferme_id, f.nom AS ferme_nom,
                e.effectif_initial, e.morts, e.vendus, e.restant, e.taux_mortalite
           FROM bandes b
           JOIN poulaillers pl ON pl.id = b.poulailler_id
           LEFT JOIN fermes f ON f.id = pl.ferme_id
           LEFT JOIN etat_bandes e ON e.bande_id = b.id
          WHERE b.id = $1`,
        [bandeId]
      ),
      pool.query(
        `SELECT id, cree_le, details
           FROM journal_activite
          WHERE bande_id = $1 AND action = 'bande_corrigee'
          ORDER BY cree_le DESC
          LIMIT 20`,
        [bandeId]
      ),
    ]);

    const b = bandes[0];
    if (!b) return res.status(404).json({ erreur: "Bande introuvable." });

    res.json({
      bande: {
        id: b.id,
        numero: b.numero,
        statut: b.statut,
        dateDebut: b.date_debut,
        dateFin: b.date_fin,
        poussinsCommandes: b.poussins_commandes,
        poussinsRecus: b.poussins_recus,
        mortsALArrivee: b.morts_a_larrivee,
        provenance: b.provenance,
        souche: b.souche,
        poidsReceptionG: b.poids_reception_g,
        payePar: b.poussins_paye_par,
        prixUnitairePoussin: b.prix_unitaire_poussin == null ? null : Number(b.prix_unitaire_poussin),
      },
      poulailler: { id: b.poulailler_id, nom: b.poulailler_nom },
      ferme: { id: b.ferme_id, nom: b.ferme_nom },
      etat: {
        effectifInitial: b.effectif_initial,
        morts: b.morts,
        vendus: b.vendus,
        restant: b.restant,
        tauxMortalite: b.taux_mortalite == null ? 0 : Number(b.taux_mortalite),
      },
      corrections: corrections.map((c) => ({
        id: c.id,
        le: c.cree_le,
        motif: c.details?.motif ?? null,
        champs: c.details?.champs ?? {},
      })),
    });
  } catch (erreur) {
    console.error("Erreur détail bande admin :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = { corrigerBande, detailBandeAdmin, LIBELLES_BANDE: LIBELLES };
