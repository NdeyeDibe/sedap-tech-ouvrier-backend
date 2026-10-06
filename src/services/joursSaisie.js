// Les journées d'une bande, faites ET non faites.
//
// Jusqu'ici, les écrans listaient les saisies en partant de la table
// « saisies_mortalite ». Un jour où personne n'a rien saisi n'a pas de
// ligne dans cette table : il disparaissait purement et simplement de
// l'historique. Le propriétaire voyait J1, J3, J4 et ne remarquait pas
// que J2 manquait.
//
// On part donc du CALENDRIER de la bande (generate_series du premier jour
// jusqu'à aujourd'hui), et on y rattache ce qui existe. Un jour sans rien
// devient une ligne visible.
//
// Ce fichier est la SEULE définition de « journée manquante ». Le
// responsable et le propriétaire la lisent tous les deux ici : s'ils
// comptaient chacun de leur côté, les deux interfaces finiraient par
// s'accuser mutuellement de se tromper.
const pool = require("../db/pool");

// Une journée est complète quand les trois étapes quotidiennes sont
// passées : mortalité, santé, alimentation. « Vu, rien à distribuer »
// (saisies_sans_donnee) compte comme faite — le responsable est passé par
// l'étape, il n'avait simplement pas de stock. Même règle que l'écran de
// saisie et que les alertes de ferme.
const REQUETE = `
  WITH b AS (
    SELECT id,
           date_debut::date AS debut,
           least(coalesce(date_fin::date, current_date), current_date) AS fin
      FROM bandes
     WHERE id = $1
  ),
  j AS (
    SELECT generate_series(b.debut, b.fin, interval '1 day')::date AS d,
           b.debut
      FROM b
  )
  SELECT
    j.d                                   AS date_saisie,
    (j.d - j.debut + 1)                   AS jour,
    (j.d = current_date)                  AS est_aujourdhui,

    (sm.id IS NOT NULL)                   AS mortalite_faite,
    (ss.id IS NOT NULL)                   AS sante_faite,
    (EXISTS (SELECT 1 FROM saisies_alimentation sa
              WHERE sa.bande_id = $1 AND sa.date_saisie = j.d)
     OR EXISTS (SELECT 1 FROM saisies_sans_donnee sd
                 WHERE sd.bande_id = $1 AND sd.date_saisie = j.d
                   AND sd.etape = 'alimentation'))  AS alimentation_faite,

    coalesce(sm.mortalite, 0)                      AS mortalite,
    coalesce(array_length(sm.photos, 1), 0)        AS nb_photos,
    sm.cree_le                                     AS saisi_le,
    ss.etat,
    ss.a_vocal,
    coalesce((SELECT sum(sa.sacs) FROM saisies_alimentation sa
               WHERE sa.bande_id = $1 AND sa.date_saisie = j.d), 0) AS sacs,
    coalesce((SELECT sum(sa.kg_supplementaires) FROM saisies_alimentation sa
               WHERE sa.bande_id = $1 AND sa.date_saisie = j.d), 0) AS kg

  FROM j
  LEFT JOIN saisies_mortalite sm ON sm.bande_id = $1 AND sm.date_saisie = j.d
  LEFT JOIN saisies_sante      ss ON ss.bande_id = $1 AND ss.date_saisie = j.d
  ORDER BY j.d DESC
`;

/**
 * @param {number|string} bandeId
 * @returns {Promise<{jours: Array, manquants: Array, nombreManquants: number}>}
 *   jours    — toutes les journées, de la plus récente à la plus ancienne
 *   manquants — seulement celles où il manque quelque chose, hors aujourd'hui
 */
async function joursDeLaBande(bandeId) {
  const { rows } = await pool.query(REQUETE, [bandeId]);

  const jours = rows.map((r) => {
    const mortaliteFaite = r.mortalite_faite;
    const santeFaite = r.sante_faite;
    const alimentationFaite = r.alimentation_faite;
    const complete = mortaliteFaite && santeFaite && alimentationFaite;
    const vide = !mortaliteFaite && !santeFaite && !alimentationFaite;

    return {
      jour: Number(r.jour),
      date: r.date_saisie,
      // La journée en cours n'est jamais « manquante » : le responsable a
      // encore le temps de la faire. L'annoncer comme un oubli dès le
      // matin ferait crier au loup tous les jours.
      etatSaisie: complete ? "complete" : r.est_aujourdhui ? "en_cours" : vide ? "manquante" : "partielle",
      mortaliteFaite,
      santeFaite,
      alimentationFaite,
      // Ce qui manque, nommé : « santé, alimentation ». Vide si complète.
      manques: [
        !mortaliteFaite && "mortalité",
        !santeFaite && "santé",
        !alimentationFaite && "alimentation",
      ].filter(Boolean),
      morts: Number(r.mortalite),
      photos: Number(r.nb_photos),
      saisiLe: r.saisi_le,
      etat: r.etat ?? "bien",
      aVocal: r.a_vocal ?? false,
      sacs: Number(r.sacs),
      kg: Number(r.kg),
    };
  });

  const manquants = jours.filter(
    (j) => j.etatSaisie === "manquante" || j.etatSaisie === "partielle"
  );

  return { jours, manquants, nombreManquants: manquants.length };
}

module.exports = { joursDeLaBande };
