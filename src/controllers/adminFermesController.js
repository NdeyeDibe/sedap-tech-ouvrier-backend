const pool = require("../db/pool");
const { chargerFerme } = require("../services/alertesFerme");
const { niveauLePlusGrave } = require("../utils/alertes");

// Détail d'une ferme — cahier admin v1.1, section VIII (maquette 07).
//
// Les bandes, effectifs et alertes viennent de chargerFerme(), exactement
// ce que voit le propriétaire : une ferme appartient à un seul propriétaire
// (cahier propriétaire v3), on la charge donc par lui.

// État du compte propriétaire, tel que l'affiche la fiche (cahier VII).
// La suspension s'ajoutera avec sa migration.
function etatCompte(p) {
  if (p.compte_verrouille) return "verrouille";
  if (!p.pin_hash) return "en_attente";
  return "actif";
}

// GET /api/admin/fermes/:id
async function detailFerme(req, res) {
  const fermeId = Number(req.params.id);
  if (!Number.isInteger(fermeId)) {
    return res.status(400).json({ erreur: "Identifiant de ferme invalide." });
  }

  try {
    const { rows: fermes } = await pool.query(
      `SELECT f.id, f.nom, f.localite, f.cree_le,
              p.id AS proprietaire_id, p.prenom, p.nom AS proprietaire_nom,
              p.telephone, p.email, p.cree_le AS proprietaire_cree_le,
              p.pin_hash, p.compte_verrouille
         FROM fermes f
         JOIN proprietaires p ON p.id = f.proprietaire_id
        WHERE f.id = $1`,
      [fermeId]
    );
    const f = fermes[0];
    if (!f) return res.status(404).json({ erreur: "Ferme introuvable." });

    const [lignes, { rows: complements }] = await Promise.all([
      chargerFerme(f.proprietaire_id),
      // Ce que chargerFerme ne donne pas : capacité, nom complet du
      // responsable, et date de la dernière saisie de chaque poulailler.
      pool.query(
        `SELECT pl.id, pl.capacite,
                o.id AS ouvrier_id, o.prenom AS ouvrier_prenom, o.nom AS ouvrier_nom,
                o.telephone AS ouvrier_telephone, (o.pin_hash IS NOT NULL) AS ouvrier_pin_cree,
                (SELECT max(d) FROM (
                   SELECT max(sm.date_saisie) AS d FROM saisies_mortalite sm
                     JOIN bandes b ON b.id = sm.bande_id WHERE b.poulailler_id = pl.id
                   UNION ALL
                   SELECT max(ss.date_saisie) FROM saisies_sante ss
                     JOIN bandes b ON b.id = ss.bande_id WHERE b.poulailler_id = pl.id
                   UNION ALL
                   SELECT max(sa.date_saisie) FROM saisies_alimentation sa
                     JOIN bandes b ON b.id = sa.bande_id WHERE b.poulailler_id = pl.id
                 ) dates) AS derniere_saisie
           FROM poulaillers pl
           LEFT JOIN personnel pe
             ON pe.poulailler_id = pl.id AND pe.role = 'responsable' AND pe.fin_fonction IS NULL
           LEFT JOIN ouvriers o ON o.id = pe.ouvrier_id
          WHERE pl.ferme_id = $1 AND pl.archive_le IS NULL`,
        [fermeId]
      ),
    ]);

    const parPoulailler = new Map(complements.map((c) => [c.id, c]));

    const poulaillers = lignes
      .filter((l) => l.ferme_id === fermeId)
      .map((l) => {
        const c = parPoulailler.get(l.poulailler_id) ?? {};
        return {
          id: l.poulailler_id,
          nom: l.poulailler_nom ?? `Poulailler ${l.poulailler_id}`,
          capacite: c.capacite ?? null,
          responsable: c.ouvrier_id
            ? {
                id: c.ouvrier_id,
                prenom: c.ouvrier_prenom,
                nom: c.ouvrier_nom,
                telephone: c.ouvrier_telephone,
                pinCree: c.ouvrier_pin_cree,
              }
            : null,
          bande: l.bande_id
            ? {
                id: l.bande_id,
                numero: l.bande_numero,
                statut: l.statut,
                ageJours: Number(l.age_jours),
                vivants: Number(l.restant),
                morts: Number(l.morts),
                tauxMortalite: l.taux_mortalite == null ? 0 : Number(l.taux_mortalite),
              }
            : null,
          statut: l.niveau,
          alertes: l.alertes.length,
          derniereSaisie: c.derniere_saisie ?? null,
        };
      });

    const alertes = lignes
      .filter((l) => l.ferme_id === fermeId)
      .flatMap((l) =>
        l.alertes.map((a) => ({
          type: a.type,
          niveau: a.niveau,
          titre: a.titre,
          message: a.message,
          bandeId: l.bande_id,
          poulailler: { id: l.poulailler_id, nom: l.poulailler_nom },
        }))
      )
      // Les urgentes d'abord, toutes poulaillers confondus.
      .sort((a, b) => (a.niveau === "urgent" ? 0 : 1) - (b.niveau === "urgent" ? 0 : 1));

    const actifs = poulaillers.filter((p) => p.bande);

    res.json({
      ferme: { id: f.id, nom: f.nom, localite: f.localite, creeLe: f.cree_le },
      proprietaire: {
        id: f.proprietaire_id,
        prenom: f.prenom,
        nom: f.proprietaire_nom,
        telephone: f.telephone,
        email: f.email,
        clientDepuis: f.proprietaire_cree_le,
        compte: etatCompte(f),
      },
      statut: niveauLePlusGrave(poulaillers.map((p) => p.statut)),
      chiffres: {
        poulaillers: poulaillers.length,
        enVente: actifs.filter((p) => p.bande.statut === "en_vente").length,
        sujetsVivants: actifs.reduce((t, p) => t + p.bande.vivants, 0),
        mortsBandesActives: actifs.reduce((t, p) => t + p.bande.morts, 0),
        alertes: alertes.length,
        urgentes: alertes.filter((a) => a.niveau === "urgent").length,
        aSurveiller: alertes.filter((a) => a.niveau !== "urgent").length,
      },
      // Cahier VIII : une bande active sans responsable est signalée en
      // haut de la fiche — plus personne ne fait les saisies.
      bandesSansResponsable: poulaillers.filter((p) => p.bande && !p.responsable).length,
      poulaillers,
      alertes,
    });
  } catch (erreur) {
    console.error("Erreur détail ferme :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = { detailFerme };
