// Historique des saisies d'une bande, pour le responsable de poulailler.
//
// Jusqu'ici il ne voyait que la journée en cours : impossible de vérifier
// ce qu'il avait déclaré la veille, ni de retrouver le jour où il avait
// donné tel produit. Ces trois lectures lui rendent ses propres saisies.
//
// Pas de pagination : une bande dure une quarantaine de jours, donc une
// quarantaine de lignes au maximum. Ajouter une pagination ici
// compliquerait l'écran pour un gain nul.
//
// Les photos de mortalité ne sont PAS renvoyées, seulement leur nombre :
// le responsable est souvent en bordure de réseau, et il cherche ici ce
// qu'il a saisi, pas à revoir ses clichés. Le propriétaire et l'admin,
// eux, les ont déjà sur leurs interfaces.
const pool = require("../db/pool");
const { joursDeLaBande } = require("../services/joursSaisie");

// Un sac d'aliment pèse 50 kg — même constante que partout ailleurs.
const POIDS_SAC_KG = 50;

// J1 = jour d'arrivée des poussins (date_debut), d'où le « + 1 ».
const JOUR = "(%s.date_saisie - b.date_debut::date + 1)";

async function historiqueMortalite(req, res) {
  const { bandeId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT sm.date_saisie,
              ${JOUR.replace("%s", "sm")} AS jour,
              sm.mortalite,
              coalesce(array_length(sm.photos, 1), 0) AS nombre_photos,
              sm.cree_le
         FROM saisies_mortalite sm
         JOIN bandes b ON b.id = sm.bande_id
        WHERE sm.bande_id = $1
        ORDER BY sm.date_saisie DESC`,
      [bandeId]
    );

    res.json({
      lignes: rows.map((l) => ({
        jour: Number(l.jour),
        date: l.date_saisie,
        saisiLe: l.cree_le,
        mortalite: Number(l.mortalite),
        nombrePhotos: Number(l.nombre_photos),
      })),
      total: rows.reduce((s, l) => s + Number(l.mortalite), 0),
    });
  } catch (erreur) {
    console.error("Erreur historique mortalité :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

async function historiqueAlimentation(req, res) {
  const { bandeId } = req.params;
  try {
    // Plusieurs lignes par jour (une par type d'aliment) : on les
    // regroupe par journée côté serveur, pour que l'écran n'ait qu'à
    // afficher.
    const { rows } = await pool.query(
      `SELECT sa.date_saisie,
              ${JOUR.replace("%s", "sa")} AS jour,
              sa.type_aliment,
              sa.sacs,
              sa.kg_supplementaires
         FROM saisies_alimentation sa
         JOIN bandes b ON b.id = sa.bande_id
        WHERE sa.bande_id = $1
        ORDER BY sa.date_saisie DESC, sa.type_aliment`,
      [bandeId]
    );

    const parJour = new Map();
    for (const l of rows) {
      const cle = String(l.date_saisie);
      if (!parJour.has(cle)) {
        parJour.set(cle, { jour: Number(l.jour), date: l.date_saisie, lignes: [], totalKg: 0 });
      }
      const kg = Number(l.sacs) * POIDS_SAC_KG + Number(l.kg_supplementaires);
      const journee = parJour.get(cle);
      journee.lignes.push({
        typeAliment: l.type_aliment,
        sacs: Number(l.sacs),
        kgSupplementaires: Number(l.kg_supplementaires),
        kg,
      });
      journee.totalKg += kg;
    }

    const lignes = [...parJour.values()];
    res.json({
      lignes,
      totalKg: lignes.reduce((s, j) => s + j.totalKg, 0),
    });
  } catch (erreur) {
    console.error("Erreur historique alimentation :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

async function historiqueProduitsUtilises(req, res) {
  const { bandeId } = req.params;
  try {
    // LEFT JOIN sur les deux tables possibles : un produit utilisé vient
    // soit du stock standard, soit de la catégorie « Autre » (nom libre).
    // COALESCE prend celui qui n'est pas NULL — un JOIN simple ferait
    // disparaître toutes les lignes « Autre ».
    const { rows } = await pool.query(
      `SELECT pu.date_saisie,
              ${JOUR.replace("%s", "pu")} AS jour,
              pu.quantite,
              coalesce(sp.nom, sap.nom) AS nom,
              sp.unite
         FROM produits_utilises pu
         JOIN bandes b ON b.id = pu.bande_id
         LEFT JOIN stock_produits sp ON sp.id = pu.stock_produit_id
         LEFT JOIN stock_autres_produits sap ON sap.id = pu.stock_autre_produit_id
        WHERE pu.bande_id = $1
        ORDER BY pu.date_saisie DESC, nom`,
      [bandeId]
    );

    const parJour = new Map();
    for (const l of rows) {
      const cle = String(l.date_saisie);
      if (!parJour.has(cle)) {
        parJour.set(cle, { jour: Number(l.jour), date: l.date_saisie, produits: [] });
      }
      parJour.get(cle).produits.push({
        nom: l.nom,
        quantite: Number(l.quantite),
        // La catégorie « Autre » n'a pas de colonne unité : on renvoie
        // null plutôt qu'inventer « unités », et l'écran n'affiche rien.
        unite: l.unite || null,
      });
    }

    res.json({ lignes: [...parJour.values()] });
  } catch (erreur) {
    console.error("Erreur historique produits utilisés :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// Les journées de la bande, celles non saisies comprises. Le responsable
// y voit ce qu'il a oublié — l'application ne pouvait jusqu'ici rien lui
// en dire, puisqu'elle ne listait que ce qui existait.
async function historiqueJours(req, res) {
  const { bandeId } = req.params;
  try {
    const { jours, manquants, nombreManquants } = await joursDeLaBande(bandeId);
    res.json({ lignes: jours, manquants, nombreManquants });
  } catch (erreur) {
    console.error("Erreur historique des journées :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = {
  historiqueMortalite,
  historiqueAlimentation,
  historiqueProduitsUtilises,
  historiqueJours,
};
