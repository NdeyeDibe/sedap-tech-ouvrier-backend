/**
 * Les flacons de vaccin disponibles, par contenance.
 *
 * POURQUOI CE SERVICE (Ndeye, 16 nov. 2026). Un flacon ne se divise pas :
 * on l'ouvre et on l'utilise, comme un comprimé qu'on ne coupe pas en
 * deux. Et un même vaccin cohabite en flacons de 500 et de 1 000 doses.
 * Pour 4 092 sujets, 4 flacons de 1 000 plus un de 500 couvrent l'effectif
 * en perdant 408 doses, là où 5 flacons de 1 000 en perdraient 908.
 *
 * Le stock, lui, est tenu en doses : 4 500 doses ne disent pas s'il
 * s'agit de 4 flacons de 1 000 et un de 500, ou de 9 de 500. On
 * reconstitue donc le détail à partir de ce qui est entré et de ce qui
 * est sorti — jamais stocké, toujours recalculé, comme les dépenses et
 * les alertes ailleurs dans cette application.
 */

/**
 * Ce qu'il reste sur l'étagère, format par format.
 *
 * Les formats épuisés sont conservés avec zéro : l'écran doit pouvoir
 * dire « flacons de 500 : aucun » plutôt que de faire disparaître une
 * ligne que le responsable cherchait.
 */
async function flaconsParFormat(client, stockProduitId) {
  const { rows } = await client.query(
    `WITH recus AS (
       SELECT sr.doses_par_unite AS doses,
              sum(sr.unites_recues)::int AS flacons
         FROM stock_receptions sr
        WHERE sr.stock_produit_id = $1
          AND sr.doses_par_unite IS NOT NULL
        GROUP BY sr.doses_par_unite
     ),
     sortis AS (
       SELECT (ligne->>'doses')::int AS doses,
              sum((ligne->>'flacons')::int)::int AS flacons
         FROM vaccinations v,
              LATERAL jsonb_array_elements(v.flacons_detail) AS ligne
        WHERE v.stock_produit_id = $1
          AND v.flacons_detail IS NOT NULL
        GROUP BY (ligne->>'doses')::int
     )
     SELECT r.doses,
            greatest(r.flacons - COALESCE(s.flacons, 0), 0) AS disponibles
       FROM recus r
       LEFT JOIN sortis s ON s.doses = r.doses
      ORDER BY r.doses DESC`,
    [stockProduitId]
  );

  return rows.map((r) => ({ doses: Number(r.doses), disponibles: Number(r.disponibles) }));
}

/**
 * La combinaison de flacons que l'application propose par défaut.
 *
 * On couvre l'effectif en gâchant le moins possible, en se servant
 * d'abord dans les grands flacons puis en complétant avec les petits —
 * c'est ce que fait le responsable lui-même, et c'est ce qui réduit le
 * nombre de flacons entamés.
 *
 * On ne cherche pas l'optimum mathématique : avec deux ou trois formats,
 * la méthode simple donne le même résultat, et une combinaison
 * incompréhensible serait pire qu'une combinaison légèrement moins bonne.
 * Le responsable a de toute façon le dernier mot.
 */
function proposerFlacons(formats, dosesACouvrir) {
  const proposition = [];
  let reste = Math.max(0, dosesACouvrir);

  // Les grands d'abord : moins de flacons à ouvrir.
  const tries = [...formats].sort((a, b) => b.doses - a.doses);

  for (const format of tries) {
    if (reste <= 0 || format.disponibles <= 0) continue;
    const voulus = Math.floor(reste / format.doses);
    const pris = Math.min(voulus, format.disponibles);
    if (pris > 0) {
      proposition.push({ doses: format.doses, flacons: pris });
      reste -= pris * format.doses;
    }
  }

  // Il manque encore de quoi couvrir tout le monde : on complète avec le
  // plus PETIT format encore disponible, pour ne pas gâcher un grand
  // flacon là où un petit suffit — c'est exactement le cas des 92 sujets
  // qui dépassent après 4 flacons de 1 000.
  if (reste > 0) {
    const petits = [...formats].sort((a, b) => a.doses - b.doses);
    for (const format of petits) {
      const dejaPris = proposition.find((p) => p.doses === format.doses);
      const restantDispo = format.disponibles - (dejaPris?.flacons ?? 0);
      if (restantDispo <= 0) continue;
      if (dejaPris) dejaPris.flacons += 1;
      else proposition.push({ doses: format.doses, flacons: 1 });
      reste -= format.doses;
      break;
    }
  }

  return proposition.sort((a, b) => b.doses - a.doses);
}

const totalDoses = (detail) =>
  (detail ?? []).reduce((t, l) => t + Number(l.doses) * Number(l.flacons), 0);

const totalFlacons = (detail) =>
  (detail ?? []).reduce((t, l) => t + Number(l.flacons), 0);

module.exports = { flaconsParFormat, proposerFlacons, totalDoses, totalFlacons };
