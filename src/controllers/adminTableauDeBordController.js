const pool = require("../db/pool");
const {
  HEURE_LIMITE_SAISIE,
  chargerToutesLesFermes,
} = require("../services/alertesFerme");
const { niveauLePlusGrave } = require("../utils/alertes");

// Tableau de bord admin — cahier admin v1.1, section V.
//
// Tout ce qui touche aux alertes vient de chargerToutesLesFermes(), la même
// fonction que celle du propriétaire : un poulailler « Urgent » chez l'admin
// l'est au même moment chez le propriétaire, et dans les notifications.
//
// Pas encore de suspension : elle arrive avec sa migration (cahier VII). Les
// chiffres « fermes actives » et le badge « Suspendu » s'y brancheront.

const LIBELLES_SAISIES = {
  mortalite: "mortalité",
  sante: "santé",
  alimentation: "aliments",
};

const ORDRE_NIVEAU = { urgent: 0, surveiller: 1, ok: 2 };

// Toutes les fermes, même celles sans poulailler encore : l'admin doit les
// voir, c'est lui qui les construit. La dernière saisie est la plus récente
// des trois saisies quotidiennes, toutes bandes de la ferme confondues.
const REQUETE_FERMES = `
  SELECT
    f.id, f.nom, f.localite,
    p.id AS proprietaire_id, p.prenom AS proprietaire_prenom, p.nom AS proprietaire_nom,
    (SELECT max(d) FROM (
       SELECT max(sm.date_saisie) AS d FROM saisies_mortalite sm
         JOIN bandes b ON b.id = sm.bande_id
         JOIN poulaillers pl ON pl.id = b.poulailler_id
        WHERE pl.ferme_id = f.id
       UNION ALL
       SELECT max(ss.date_saisie) FROM saisies_sante ss
         JOIN bandes b ON b.id = ss.bande_id
         JOIN poulaillers pl ON pl.id = b.poulailler_id
        WHERE pl.ferme_id = f.id
       UNION ALL
       SELECT max(sa.date_saisie) FROM saisies_alimentation sa
         JOIN bandes b ON b.id = sa.bande_id
         JOIN poulaillers pl ON pl.id = b.poulailler_id
        WHERE pl.ferme_id = f.id
     ) dates) AS derniere_saisie
  FROM fermes f
  JOIN proprietaires p ON p.id = f.proprietaire_id
  ORDER BY f.nom
`;

// GET /api/admin/tableau-de-bord
async function tableauDeBord(req, res) {
  try {
    const [lignes, { rows: fermes }] = await Promise.all([
      chargerToutesLesFermes(),
      pool.query(REQUETE_FERMES),
    ]);

    // ---------------------------------------------- par ferme
    const parFerme = new Map(
      fermes.map((f) => [
        f.id,
        {
          id: f.id,
          nom: f.nom,
          localite: f.localite,
          proprietaire: {
            id: f.proprietaire_id,
            prenom: f.proprietaire_prenom,
            nom: f.proprietaire_nom,
          },
          poulaillers: 0,
          poulaillersEnVente: 0,
          bandesActives: 0,
          sujetsVivants: 0,
          alertes: 0,
          statut: "ok",
          derniereSaisie: f.derniere_saisie,
        },
      ])
    );

    const saisiesManquantes = [];
    let urgentes = 0;
    let aSurveiller = 0;

    for (const l of lignes) {
      const ferme = parFerme.get(l.ferme_id);
      if (!ferme) continue;

      ferme.poulaillers += 1;

      if (l.bande_id) {
        ferme.bandesActives += 1;
        ferme.sujetsVivants += Number(l.restant);
        if (l.statut === "en_vente") ferme.poulaillersEnVente += 1;
      }

      ferme.alertes += l.alertes.length;
      ferme.statut = niveauLePlusGrave([ferme.statut, l.niveau]);

      for (const a of l.alertes) {
        if (a.niveau === "urgent") urgentes += 1;
        else aSurveiller += 1;
      }

      if (l.saisiesManquantes.length > 0) {
        saisiesManquantes.push({
          ferme: { id: l.ferme_id, nom: l.ferme_nom },
          poulailler: { id: l.poulailler_id, nom: l.poulailler_nom },
          bandeId: l.bande_id,
          ouvrier: l.ouvrier_prenom
            ? { prenom: l.ouvrier_prenom, telephone: l.ouvrier_telephone }
            : null,
          manquantes: l.saisiesManquantes,
          libelle: l.saisiesManquantes.map((s) => LIBELLES_SAISIES[s]).join(", "),
        });
      }
    }

    // Tri du cahier : Urgent, puis À surveiller, puis Tout va bien ; puis nom.
    const listeFermes = [...parFerme.values()].sort(
      (a, b) =>
        ORDRE_NIVEAU[a.statut] - ORDRE_NIVEAU[b.statut] ||
        a.nom.localeCompare(b.nom, "fr")
    );

    res.json({
      chiffres: {
        // « Actives » = au moins une bande en cours ou en vente.
        fermesActives: listeFermes.filter((f) => f.bandesActives > 0).length,
        fermesTotal: listeFermes.length,
        poulaillers: lignes.length,
        poulaillersAvecBande: lignes.filter((l) => l.bande_id).length,
        sujetsVivants: listeFermes.reduce((t, f) => t + f.sujetsVivants, 0),
        alertesActives: urgentes + aSurveiller,
        alertesUrgentes: urgentes,
        alertesASurveiller: aSurveiller,
      },
      saisiesManquantes: {
        heureControle: HEURE_LIMITE_SAISIE,
        // Vide avant 18 h : c'est alertesFerme qui applique l'heure limite.
        poulaillers: saisiesManquantes,
      },
      fermes: listeFermes,
    });
  } catch (erreur) {
    console.error("Erreur tableau de bord admin :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = { tableauDeBord };
