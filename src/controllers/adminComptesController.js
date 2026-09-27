const pool = require("../db/pool");
const { parAdmin } = require("../services/journal");

// Déverrouillage d'un compte — cahier admin, section VII.
//
// Trois mauvais codes PIN et le compte se bloque (authController pour
// l'ouvrier, proprietaireAuthController pour le propriétaire). Le message
// affiché dit « Contactez le support SEDAP » — encore faut-il que le
// support puisse faire quelque chose. Jusqu'ici, il fallait une requête SQL
// dans Railway : hors de portée en dehors de cette conversation, et risqué.
//
// Ce que fait le déverrouillage, et rien de plus :
//  - remet le compteur d'essais à zéro ;
//  - lève le verrou.
// Le code PIN n'est PAS touché : la personne se reconnecte avec le sien.
// Si elle l'a oublié, c'est une autre action (réinitialisation), qui
// mérite son propre écran et sa propre trace.

// Une seule fonction pour les deux tables : la colonne et la règle sont
// identiques, seul le libellé change.
const COMPTES = {
  ouvrier: {
    table: "ouvriers",
    libelle: "ouvrier",
    // De quoi écrire une entrée de journal rattachée à la bonne ferme.
    contexte: async (id) => {
      const { rows } = await pool.query(
        `SELECT pe.ferme_id, pe.poulailler_id
           FROM personnel pe
          WHERE pe.ouvrier_id = $1 AND pe.fin_fonction IS NULL
          LIMIT 1`,
        [id]
      );
      return { fermeId: rows[0]?.ferme_id, poulaillerId: rows[0]?.poulailler_id };
    },
  },
  proprietaire: {
    table: "proprietaires",
    libelle: "propriétaire",
    contexte: async (id) => ({ proprietaireId: id }),
  },
};

// PATCH /api/admin/ouvriers/:id/deverrouiller
// PATCH /api/admin/proprietaires/:id/deverrouiller
function deverrouiller(type) {
  const compte = COMPTES[type];

  return async function (req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ erreur: "Identifiant invalide." });
    }

    try {
      // RETURNING donne l'état APRÈS ; on lit l'état d'avant dans la même
      // requête pour savoir si le compte était réellement verrouillé (utile
      // au journal, et à ce qu'on répond à l'écran).
      const { rows } = await pool.query(
        `UPDATE ${compte.table} AS c
            SET compte_verrouille = false, tentatives_echouees = 0
           FROM ${compte.table} AS avant
          WHERE c.id = $1 AND avant.id = c.id
      RETURNING c.id, c.prenom, c.nom,
                avant.compte_verrouille AS etait_verrouille,
                avant.tentatives_echouees AS essais_avant,
                (c.pin_hash IS NOT NULL) AS a_un_pin`,
        [id]
      );

      const ligne = rows[0];
      if (!ligne) {
        return res.status(404).json({ erreur: `Compte ${compte.libelle} introuvable.` });
      }

      // Rien ne changeait : on répond quand même 200 (l'écran a pu être
      // ouvert depuis un moment), mais sans polluer le journal.
      if (ligne.etait_verrouille || ligne.essais_avant > 0) {
        parAdmin(req, {
          action: "compte_deverrouille",
          cibleType: type,
          cibleId: id,
          ...(await compte.contexte(id)),
          details: {
            etaitVerrouille: ligne.etait_verrouille,
            essaisRemisAZero: ligne.essais_avant,
          },
        });
      }

      res.json({
        id: ligne.id,
        prenom: ligne.prenom,
        nom: ligne.nom,
        compte: ligne.a_un_pin ? "actif" : "en_attente",
        etaitVerrouille: ligne.etait_verrouille,
      });
    } catch (erreur) {
      console.error(`Erreur déverrouillage ${compte.libelle} :`, erreur);
      res.status(500).json({ erreur: "Erreur serveur." });
    }
  };
}

// POST /api/admin/ouvriers/:id/reinitialiser-pin
//
// L'ouvrier a oublié son code, pas seulement raté trois fois. Chez le
// propriétaire on lui renvoie un lien ; l'ouvrier n'en a jamais eu : son
// compte est créé par SEDAP et il choisit son PIN au premier démarrage de
// l'appli. Effacer le PIN le ramène donc exactement là — l'écran de
// création s'affiche de lui-même au prochain lancement.
//
// SEDAP ne choisit jamais le code de quelqu'un : ni ici, ni ailleurs.
async function reinitialiserPinOuvrier(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ erreur: "Identifiant invalide." });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE ouvriers
          SET pin_hash = NULL, tentatives_echouees = 0, compte_verrouille = false
        WHERE id = $1
        RETURNING id, prenom, nom, telephone`,
      [id]
    );

    const ligne = rows[0];
    if (!ligne) return res.status(404).json({ erreur: "Compte ouvrier introuvable." });

    parAdmin(req, {
      action: "pin_reinitialise",
      cibleType: "ouvrier",
      cibleId: id,
      ...(await COMPTES.ouvrier.contexte(id)),
      details: {},
    });

    res.json({
      id: ligne.id,
      prenom: ligne.prenom,
      nom: ligne.nom,
      telephone: ligne.telephone,
      compte: "en_attente",
      // Ce que l'admin doit dire à l'ouvrier au téléphone.
      consigne:
        "Demandez-lui d'ouvrir l'application : elle lui proposera de choisir un nouveau code à 4 chiffres.",
    });
  } catch (erreur) {
    console.error("Erreur réinitialisation PIN ouvrier :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = {
  deverrouillerOuvrier: deverrouiller("ouvrier"),
  deverrouillerProprietaire: deverrouiller("proprietaire"),
  reinitialiserPinOuvrier,
};
