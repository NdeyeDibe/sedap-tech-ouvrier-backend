const pool = require("../db/pool");
const { alertesBande, statutBande, kgDistribues } = require("../utils/alertes");

// État courant des poulaillers d'un propriétaire, alertes comprises.
//
// Trois lecteurs en ont besoin : le tableau de bord, la liste des alertes
// et la surveillance automatique qui envoie les notifications. Tout passe
// par ici, pour qu'une alerte visible dans l'appli soit exactement celle
// qui a été notifiée — et inversement.

// Heure à partir de laquelle une saisie du jour incomplète devient une
// alerte. Heure de Dakar, quel que soit le fuseau du serveur.
const HEURE_LIMITE_SAISIE = "18:00";

// Un pesage oublié ne se rattrape pas (il est lié à un jour précis) :
// on le signale pendant 2 jours, le temps que le propriétaire réagisse,
// puis il ne reste visible que dans le programme du poulailler.
const JOURS_ALERTE_PESAGE = 2;

const REQUETE_FERME = `
  SELECT
    pl.id                AS poulailler_id,
    pl.nom               AS poulailler_nom,
    b.id                 AS bande_id,
    b.numero             AS bande_numero,
    b.statut,
    b.date_debut,
    -- Le jour du démarrage est J1, pas J0.
    (current_date - b.date_debut::date + 1) AS age_jours,
    b.poussins_commandes,
    b.poussins_recus,
    b.morts_a_larrivee,
    e.morts,
    e.vendus,
    e.restant,
    e.taux_mortalite,
    r.sujets_sans_prix,

    coalesce((
      SELECT sum(v.quantite) FROM ventes v
       WHERE v.bande_id = b.id AND v.type_vente = 'ramassage'
    ), 0) AS ramasses,
    coalesce((
      SELECT sum(v.quantite) FROM ventes v
       WHERE v.bande_id = b.id AND v.type_vente = 'ferme'
    ), 0) AS vendus_ferme,

    -- Mortalité du jour et des trois jours précédents.
    coalesce((
      SELECT sm.mortalite FROM saisies_mortalite sm
       WHERE sm.bande_id = b.id AND sm.date_saisie = current_date
    ), 0) AS morts_du_jour,
    coalesce((
      SELECT array_agg(sm.mortalite ORDER BY sm.date_saisie DESC)
        FROM (
          SELECT mortalite, date_saisie FROM saisies_mortalite
           WHERE bande_id = b.id AND date_saisie < current_date
           ORDER BY date_saisie DESC LIMIT 3
        ) sm
    ), '{}') AS morts_precedents,

    coalesce((
      SELECT ss.etat FROM saisies_sante ss
       WHERE ss.bande_id = b.id AND ss.date_saisie = current_date
    ), 'bien') AS etat_ouvrier,

    -- Les trois saisies du jour : faites ou non.
    EXISTS (SELECT 1 FROM saisies_mortalite sm
             WHERE sm.bande_id = b.id AND sm.date_saisie = current_date) AS mortalite_faite,
    EXISTS (SELECT 1 FROM saisies_sante ss
             WHERE ss.bande_id = b.id AND ss.date_saisie = current_date) AS sante_faite,
    -- « Vu, rien à déclarer » (pas de stock d'aliment) compte comme une
    -- saisie faite : l'ouvrier est passé par l'étape, il n'avait rien à
    -- distribuer. Même règle que l'écran de l'ouvrier (saisieController).
    (EXISTS (SELECT 1 FROM saisies_alimentation sa
              WHERE sa.bande_id = b.id AND sa.date_saisie = current_date)
     OR EXISTS (SELECT 1 FROM saisies_sans_donnee sd
                 WHERE sd.bande_id = b.id AND sd.date_saisie = current_date
                   AND sd.etape = 'alimentation')) AS alimentation_faite,
    (now() AT TIME ZONE 'Africa/Dakar')::time >= '${HEURE_LIMITE_SAISIE}' AS heure_limite_passee,

    -- Réceptions rattachées à cette bande dont le prix n'a pas encore été
    -- renseigné par le propriétaire (vue receptions_ferme, migration 015).
    coalesce((
      SELECT count(*) FROM receptions_ferme rf
       WHERE rf.bande_id = b.id AND rf.prix_unitaire IS NULL
    ), 0) AS receptions_sans_prix,

    coalesce((
      SELECT sum(sp.quantite) FROM stock_produits sp
       WHERE sp.poulailler_id = pl.id AND sp.produit_id = 'aliment'
    ), 0) AS aliment_restant_kg,

    coalesce((
      SELECT sum(sa.sacs) FROM saisies_alimentation sa
       WHERE sa.bande_id = b.id AND sa.date_saisie = current_date - 1
    ), 0) AS sacs_hier,
    coalesce((
      SELECT sum(sa.kg_supplementaires) FROM saisies_alimentation sa
       WHERE sa.bande_id = b.id AND sa.date_saisie = current_date - 1
    ), 0) AS kg_hier,

    pe.prenom     AS ouvrier_prenom,
    pe.telephone  AS ouvrier_telephone

  FROM poulaillers pl
  JOIN fermes f ON f.id = pl.ferme_id
  LEFT JOIN bandes b ON b.poulailler_id = pl.id AND b.statut <> 'terminee'
  LEFT JOIN etat_bandes e ON e.bande_id = b.id
  LEFT JOIN recettes_bandes r ON r.bande_id = b.id
  LEFT JOIN personnel pe
    ON pe.poulailler_id = pl.id
   AND pe.role = 'responsable'
   AND pe.fin_fonction IS NULL
  WHERE f.proprietaire_id = $1
    AND ($2::int IS NULL OR pl.id = $2)
  ORDER BY pl.id
`;

// Actes du programme sanitaire en retard : le premier vaccin manqué, et le
// pesage manqué le plus récent s'il date de moins de JOURS_ALERTE_PESAGE.
const REQUETE_RETARDS = `
  SELECT bande_id, type, nom, jour_debut, date_limite
    FROM programme_bandes
   WHERE bande_id = ANY($1)
     AND en_retard
     AND (
       type = 'vaccin'
       OR (type = 'pesage' AND date_limite >= current_date - ${JOURS_ALERTE_PESAGE})
     )
   ORDER BY ordre
`;

function construireBande(ligne, retards = []) {
  const vaccin = retards.find((r) => r.type === "vaccin");
  const pesage = retards.filter((r) => r.type === "pesage").pop();

  const saisiesManquantes = ligne.heure_limite_passee
    ? ["mortalite", "sante", "alimentation"].filter((s) => !ligne[`${s}_faite`])
    : [];

  return {
    mortsDuJour: Number(ligne.morts_du_jour),
    sujetsVivants: Number(ligne.restant),
    ageJours: Number(ligne.age_jours),
    mortsJoursPrecedents: (ligne.morts_precedents || []).map(Number),
    etatOuvrier: ligne.etat_ouvrier,
    stockRestantKg: Number(ligne.aliment_restant_kg),
    distribueVeilleKg: kgDistribues({
      sacs: ligne.sacs_hier,
      kg_supplementaires: ligne.kg_hier,
    }),
    prochainVaccin: vaccin
      ? {
          nom: vaccin.nom,
          jour: vaccin.jour_debut,
          datePrevue: vaccin.date_limite,
          confirme: false,
        }
      : null,
    pesageManque: pesage ? { jour: pesage.jour_debut } : null,
    receptionsSansPrix: Number(ligne.receptions_sans_prix),
    saisiesManquantes,
  };
}

// Renvoie les lignes de la requête, chacune complétée de ses alertes et de
// son niveau (ok, surveiller, urgent). Un poulailler sans bande active n'a rien à surveiller.
async function chargerFerme(proprietaireId, poulaillerId = null) {
  const { rows } = await pool.query(REQUETE_FERME, [
    proprietaireId,
    poulaillerId,
  ]);

  const bandeIds = rows.filter((l) => l.bande_id).map((l) => l.bande_id);

  const retardsParBande = {};
  if (bandeIds.length > 0) {
    const { rows: retards } = await pool.query(REQUETE_RETARDS, [bandeIds]);
    for (const r of retards) {
      (retardsParBande[r.bande_id] ??= []).push(r);
    }
  }

  return rows.map((ligne) => {
    // « niveau » et non « statut » : ligne.statut est déjà celui de la
    // bande (en_cours, en_vente).
    if (!ligne.bande_id) return { ...ligne, alertes: [], niveau: "ok" };

    const bande = construireBande(ligne, retardsParBande[ligne.bande_id]);
    return {
      ...ligne,
      alertes: alertesBande(bande),
      niveau: statutBande(bande),
    };
  });
}

const ouvrierDe = (ligne) =>
  ligne.ouvrier_prenom
    ? { nom: ligne.ouvrier_prenom, telephone: ligne.ouvrier_telephone }
    : null;

// Toutes les alertes de la ferme, à plat, chacune avec son poulailler.
async function alertesDeLaFerme(proprietaireId) {
  const lignes = await chargerFerme(proprietaireId);

  return lignes.flatMap((ligne) =>
    ligne.alertes.map((alerte) => ({
      ...alerte,
      bandeId: ligne.bande_id,
      poulailler: { id: ligne.poulailler_id, nom: ligne.poulailler_nom },
      ouvrier: ouvrierDe(ligne),
    }))
  );
}

module.exports = { chargerFerme, alertesDeLaFerme, ouvrierDe };
