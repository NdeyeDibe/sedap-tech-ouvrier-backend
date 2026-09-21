const pool = require("../db/pool");

// Journal d'activité — cahier admin v1.2, section X bis.
//
// Règle d'or : un enregistrement qui échoue ne bloque jamais l'action
// elle-même. D'où trois choix :
//  - on journalise APRÈS que l'action a réussi (et après le COMMIT s'il y a
//    une transaction) ;
//  - on passe par le pool, jamais par le client d'une transaction : une
//    erreur ici annulerait la transaction entière dans PostgreSQL ;
//  - toute erreur est attrapée et seulement écrite dans les logs.
//
// L'appelant n'attend pas le résultat (pas de await) : la réponse à
// l'utilisateur ne doit pas dépendre du journal.

// Complète ferme et poulailler à partir de la bande ou du poulailler, pour
// que chaque entrée soit retrouvable depuis la ferme sans jointure.
async function contexte({ proprietaireId, fermeId, poulaillerId, bandeId }) {
  if (bandeId && (!poulaillerId || !fermeId || !proprietaireId)) {
    const { rows } = await pool.query(
      `SELECT b.poulailler_id, pl.ferme_id, f.proprietaire_id
         FROM bandes b
         JOIN poulaillers pl ON pl.id = b.poulailler_id
         LEFT JOIN fermes f ON f.id = pl.ferme_id
        WHERE b.id = $1`,
      [bandeId]
    );
    if (rows[0]) {
      poulaillerId ??= rows[0].poulailler_id;
      fermeId ??= rows[0].ferme_id;
      proprietaireId ??= rows[0].proprietaire_id;
    }
  } else if (poulaillerId && (!fermeId || !proprietaireId)) {
    const { rows } = await pool.query(
      `SELECT pl.ferme_id, f.proprietaire_id
         FROM poulaillers pl LEFT JOIN fermes f ON f.id = pl.ferme_id
        WHERE pl.id = $1`,
      [poulaillerId]
    );
    if (rows[0]) {
      fermeId ??= rows[0].ferme_id;
      proprietaireId ??= rows[0].proprietaire_id;
    }
  } else if (fermeId && !proprietaireId) {
    const { rows } = await pool.query(
      "SELECT proprietaire_id FROM fermes WHERE id = $1",
      [fermeId]
    );
    proprietaireId ??= rows[0]?.proprietaire_id;
  } else if (proprietaireId && !fermeId) {
    // Actions sur le compte (activation, profil, verrouillage) : on les
    // rattache quand même à la ferme, pour l'historique de la ferme.
    const { rows } = await pool.query(
      "SELECT id FROM fermes WHERE proprietaire_id = $1",
      [proprietaireId]
    );
    fermeId = rows[0]?.id;
  }
  return { proprietaireId, fermeId, poulaillerId, bandeId };
}

/**
 * Enregistre une entrée. Ne lève jamais d'erreur.
 *
 * @param {object} e
 * @param {'admin'|'proprietaire'|'ouvrier'|'systeme'} e.acteurType
 * @param {number|null} e.acteurId
 * @param {string} e.action       ex. 'vente_supprimee'
 * @param {string} [e.cibleType]  ex. 'vente'
 * @param {number} [e.cibleId]
 * @param {number} [e.proprietaireId]
 * @param {number} [e.fermeId]
 * @param {number} [e.poulaillerId]
 * @param {number} [e.bandeId]
 * @param {object} [e.details]    valeurs avant/après, ou la ligne supprimée
 */
async function journaliser(e) {
  try {
    const c = await contexte(e);
    await pool.query(
      `INSERT INTO journal_activite
         (acteur_type, acteur_id, action, proprietaire_id, ferme_id,
          poulailler_id, bande_id, cible_type, cible_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        e.acteurType,
        e.acteurId ?? null,
        e.action,
        c.proprietaireId ?? null,
        c.fermeId ?? null,
        c.poulaillerId ?? null,
        c.bandeId ?? null,
        e.cibleType ?? null,
        e.cibleId ?? null,
        JSON.stringify(e.details ?? {}),
      ]
    );
  } catch (erreur) {
    console.error(`Journal d'activité non enregistré (${e.action}) :`, erreur.message);
  }
}

/** Raccourci pour les routes du propriétaire connecté. */
const parProprietaire = (req, entree) =>
  journaliser({
    acteurType: "proprietaire",
    acteurId: req.utilisateur.id,
    proprietaireId: req.utilisateur.id,
    ...entree,
  });

/** Raccourci pour les routes admin. */
const parAdmin = (req, entree) =>
  journaliser({ acteurType: "admin", acteurId: req.utilisateur.id, ...entree });

/**
 * Ne garde que les champs qui ont changé : { champ: { avant, apres } }.
 * Les nombres venus de PostgreSQL (NUMERIC → chaîne) sont comparés en valeur.
 */
function differences(avant, apres, champs) {
  const diff = {};
  for (const champ of champs) {
    if (!(champ in apres) || apres[champ] === undefined) continue;
    const a = avant?.[champ] ?? null;
    const b = apres[champ] ?? null;
    const egaux =
      a === b || (a != null && b != null && String(a) === String(b));
    if (!egaux) diff[champ] = { avant: a, apres: b };
  }
  return diff;
}

module.exports = { journaliser, parProprietaire, parAdmin, differences };
