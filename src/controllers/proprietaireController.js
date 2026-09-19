const pool = require("../db/pool");
const {
  chargerFerme,
  alertesDeLaFerme,
  ouvrierDe,
} = require("../services/alertesFerme");

// Les requêtes d'état (effectifs, saisies du jour, stock) et le calcul des
// alertes vivent dans services/alertesFerme.js : la surveillance qui envoie
// les notifications s'en sert aussi, et doit dire exactement la même chose.

async function tableauDeBord(req, res) {
  try {
    const lignes = await chargerFerme(req.utilisateur.id);

    const poulaillers = lignes.map((ligne) => {
      if (!ligne.bande_id) {
        return {
          id: ligne.poulailler_id,
          nom: ligne.poulailler_nom,
          bandeActive: null,
          alertes: [],
          statut: "ok",
        };
      }

      return {
        id: ligne.poulailler_id,
        nom: ligne.poulailler_nom,
        ouvrier: ouvrierDe(ligne),
        bandeActive: {
          id: ligne.bande_id,
          numero: ligne.bande_numero,
          statut: ligne.statut,
          ageJours: Number(ligne.age_jours),
          poussinsRecus: Number(ligne.poussins_recus),
          morts: Number(ligne.morts),
          vendus: Number(ligne.vendus),
          ramasses: Number(ligne.ramasses),
          vendusFerme: Number(ligne.vendus_ferme),
          restant: Number(ligne.restant),
          tauxMortalite: ligne.taux_mortalite
            ? Number(ligne.taux_mortalite)
            : 0,
          sujetsSansPrix: Number(ligne.sujets_sans_prix),
        },
        alertes: ligne.alertes,
        statut: ligne.niveau,
      };
    });

    const actives = poulaillers.filter((p) => p.bandeActive);

    res.json({
      poulaillers,
      totaux: {
        sujetsVivants: actives.reduce((t, p) => t + p.bandeActive.restant, 0),
        sujetsMorts: actives.reduce((t, p) => t + p.bandeActive.morts, 0),
        alertesActives: poulaillers.reduce((t, p) => t + p.alertes.length, 0),
      },
    });
  } catch (erreur) {
    console.error("Erreur tableau de bord :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// ---------------------------------------------------------------- détail

// Le détail reprend la même base que le tableau de bord — un seul poulailler
// cette fois — puis y ajoute ce que la carte n'affiche pas : réception,
// saisies récentes, programme de vaccination, stock.

const REQUETE_SAISIES = `
  SELECT
    sm.date_saisie,
    sm.mortalite,
    coalesce(array_length(sm.photos, 1), 0) AS nb_photos,
    ss.etat,
    ss.a_vocal,
    coalesce((
      SELECT sum(sa.sacs) FROM saisies_alimentation sa
       WHERE sa.bande_id = $1 AND sa.date_saisie = sm.date_saisie
    ), 0) AS sacs,
    coalesce((
      SELECT sum(sa.kg_supplementaires) FROM saisies_alimentation sa
       WHERE sa.bande_id = $1 AND sa.date_saisie = sm.date_saisie
    ), 0) AS kg
  FROM saisies_mortalite sm
  LEFT JOIN saisies_sante ss
    ON ss.bande_id = sm.bande_id AND ss.date_saisie = sm.date_saisie
  WHERE sm.bande_id = $1
  ORDER BY sm.date_saisie DESC
  LIMIT $2
`;

// Le programme sanitaire complet : ce qui était prévu, ce qui a été fait,
// ce qui est en retard. La vue programme_bandes croise le programme de
// référence avec les actes réellement enregistrés.
const REQUETE_PROGRAMME = `
  SELECT ordre, nom, type, jour_debut, jour_fin,
         date_prevue, date_limite, confirme, date_faite, en_retard
    FROM programme_bandes
   WHERE bande_id = $1
   ORDER BY ordre
`;

// Ce que la bande a coûté jusqu'ici. Les dépenses sont définitives dès
// qu'elles sont engagées — contrairement aux recettes, qui bougent tant que
// la vente court. Les montrer en temps réel permet au propriétaire de
// recouper chaque achat le jour même, au lieu de le découvrir au bilan.
const LIBELLE_POSTE = {
  aliment: 'Aliment',
  gaz: 'Gaz',
  litiere: 'Litière',
  vitamines: 'Vitamines',
  antistress: 'Antistress',
  vaccin: 'Médicaments & vaccins',
  autres: 'Autres produits',
};

const REQUETE_DEPENSES = `
  SELECT poste, quantite, cout
    FROM depenses_bandes
   WHERE bande_id = $1
   ORDER BY cout DESC
`;

const REQUETE_STOCK = `
  SELECT produit_id, variante_id, nom, unite, quantite
    FROM stock_produits
   WHERE poulailler_id = $1 AND quantite > 0
   ORDER BY produit_id, variante_id
`;

// Un libellé de date lisible plutôt qu'une date brute : le propriétaire lit
// « Hier » plus vite qu'une date, et l'écran l'affiche tel quel.
function libelleJour(date) {
  const jours = Math.round(
    (new Date().setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0)) /
      86400000
  );

  if (jours === 0) return "Aujourd'hui";
  if (jours === 1) return "Hier";
  if (jours === 2) return "Avant-hier";
  return `Il y a ${jours} jours`;
}

async function detailPoulailler(req, res) {
  const { poulaillerId } = req.params;

  try {
    // Un identifiant non numérique ne peut désigner aucun poulailler.
    if (!/^\d+$/.test(poulaillerId)) {
      return res.status(404).json({ erreur: "Poulailler introuvable." });
    }

    const rows = await chargerFerme(req.utilisateur.id, Number(poulaillerId));

    // Aucune ligne : soit le poulailler n'existe pas, soit il n'est pas à lui.
    // On ne distingue pas les deux, pour ne rien révéler d'une autre ferme.
    if (rows.length === 0) {
      return res.status(404).json({ erreur: "Poulailler introuvable." });
    }

    const ligne = rows[0];

    if (!ligne.bande_id) {
      return res.json({
        id: ligne.poulailler_id,
        nom: ligne.poulailler_nom,
        ouvrier: ligne.ouvrier_prenom
          ? { nom: ligne.ouvrier_prenom, telephone: ligne.ouvrier_telephone }
          : null,
        bandeActive: null,
        saisies: [],
        programme: [],
        depenses: { lignes: [], total: 0 },
        stock: [],
        alertes: [],
        statut: "ok",
      });
    }

    const [saisies, programme, stock, depenses] = await Promise.all([
      pool.query(REQUETE_SAISIES, [ligne.bande_id, 10]),
      pool.query(REQUETE_PROGRAMME, [ligne.bande_id]),
      pool.query(REQUETE_STOCK, [ligne.poulailler_id]),
      pool.query(REQUETE_DEPENSES, [ligne.bande_id]),
    ]);

    res.json({
      id: ligne.poulailler_id,
      nom: ligne.poulailler_nom,
      ouvrier: ligne.ouvrier_prenom
        ? { nom: ligne.ouvrier_prenom, telephone: ligne.ouvrier_telephone }
        : null,

      bandeActive: {
        id: ligne.bande_id,
        numero: ligne.bande_numero,
        statut: ligne.statut,
        dateDebut: ligne.date_debut,
        ageJours: Number(ligne.age_jours),
        reception: {
          commandes:
            ligne.poussins_commandes === null
              ? null
              : Number(ligne.poussins_commandes),
          recus: Number(ligne.poussins_recus),
          mortsArrivee: Number(ligne.morts_a_larrivee),
        },
        morts: Number(ligne.morts),
        vendus: Number(ligne.vendus),
        ramasses: Number(ligne.ramasses),
        vendusFerme: Number(ligne.vendus_ferme),
        restant: Number(ligne.restant),
        tauxMortalite: ligne.taux_mortalite ? Number(ligne.taux_mortalite) : 0,
        sujetsSansPrix: Number(ligne.sujets_sans_prix),
      },

      saisies: saisies.rows.map((s) => ({
        date: s.date_saisie,
        libelle: libelleJour(s.date_saisie),
        morts: Number(s.mortalite),
        photos: Number(s.nb_photos),
        sacs: Number(s.sacs),
        kg: Number(s.kg),
        etat: s.etat ?? "bien",
        aVocal: s.a_vocal ?? false,
      })),

      programme: programme.rows.map((p) => ({
        nom: p.nom,
        type: p.type,
        jourDebut: p.jour_debut,
        jourFin: p.jour_fin,
        datePrevue: p.date_prevue,
        dateLimite: p.date_limite,
        confirme: p.confirme,
        dateFaite: p.date_faite,
        enRetard: p.en_retard,
      })),

      depenses: {
        lignes: depenses.rows.map((d) => ({
          poste: d.poste,
          libelle: LIBELLE_POSTE[d.poste] ?? d.poste,
          quantite: Number(d.quantite),
          cout: Number(d.cout),
        })),
        total: depenses.rows.reduce((t, d) => t + Number(d.cout), 0),
      },

      stock: stock.rows.map((p) => ({
        produit: p.produit_id,
        variante: p.variante_id,
        nom: p.nom,
        unite: p.unite,
        quantite: Number(p.quantite),
      })),

      alertes: ligne.alertes,
      statut: ligne.niveau,
    });
  } catch (erreur) {
    console.error("Erreur détail poulailler :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// ------------------------------------------------ historique et photos

// Vérifie que la bande appartient bien à la ferme du propriétaire connecté.
// Sans ce garde-fou, un identifiant de bande deviné donnerait accès aux
// saisies d'une autre ferme.
const REQUETE_BANDE_AUTORISEE = `
  SELECT b.id, b.poulailler_id, pl.nom AS poulailler_nom
    FROM bandes b
    JOIN poulaillers pl ON pl.id = b.poulailler_id
    JOIN fermes f ON f.id = pl.ferme_id
   WHERE b.id = $1 AND f.proprietaire_id = $2
`;

async function bandeAutorisee(bandeId, proprietaireId) {
  const { rows } = await pool.query(REQUETE_BANDE_AUTORISEE, [
    bandeId,
    proprietaireId,
  ]);
  return rows[0] ?? null;
}

// Toutes les saisies d'une bande, sans limite de nombre : l'écran les
// regroupe par jour et replie au-delà d'un certain volume.
async function historiqueSaisies(req, res) {
  const { bandeId } = req.params;

  try {
    const bande = await bandeAutorisee(bandeId, req.utilisateur.id);
    if (!bande) return res.status(404).json({ erreur: "Bande introuvable." });

    const { rows } = await pool.query(REQUETE_SAISIES, [bandeId, 500]);

    res.json({
      bandeId: Number(bandeId),
      poulailler: bande.poulailler_nom,
      saisies: rows.map((s) => ({
        date: s.date_saisie,
        libelle: libelleJour(s.date_saisie),
        morts: Number(s.mortalite),
        photos: Number(s.nb_photos),
        sacs: Number(s.sacs),
        kg: Number(s.kg),
        etat: s.etat ?? "bien",
        aVocal: s.a_vocal ?? false,
      })),
    });
  } catch (erreur) {
    console.error("Erreur historique des saisies :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// Les photos prises par l'ouvrier lors d'une saisie de mortalité. Elles sont
// déjà sur le serveur d'images : le propriétaire n'a rien à faire pour y
// accéder, on ne renvoie que leurs adresses.
const REQUETE_PHOTOS = `
  SELECT sm.date_saisie, sm.mortalite, sm.photos,
         ss.etat, ss.a_vocal, ss.vocal_url, ss.photos AS photos_sante
    FROM saisies_mortalite sm
    LEFT JOIN saisies_sante ss
      ON ss.bande_id = sm.bande_id AND ss.date_saisie = sm.date_saisie
   WHERE sm.bande_id = $1 AND sm.date_saisie = $2
`;

async function photosMortalite(req, res) {
  const { bandeId, date } = req.params;

  try {
    const bande = await bandeAutorisee(bandeId, req.utilisateur.id);
    if (!bande) return res.status(404).json({ erreur: "Bande introuvable." });

    const { rows } = await pool.query(REQUETE_PHOTOS, [bandeId, date]);
    if (rows.length === 0) {
      return res.status(404).json({ erreur: "Aucune saisie à cette date." });
    }

    const saisie = rows[0];
    const photos = saisie.photos ?? [];

    res.json({
      date: saisie.date_saisie,
      libelle: libelleJour(saisie.date_saisie),
      morts: Number(saisie.mortalite),
      etat: saisie.etat ?? "bien",
      // Le CDC prévoyait un texte, la maquette montre un vocal.
      // vocal_url est nul sur les saisies antérieures à son ajout : le
      // vocal a existé, mais n'a jamais quitté le téléphone de l'ouvrier.
      aVocal: saisie.a_vocal ?? false,
      vocalUrl: saisie.vocal_url ?? null,
      photos: photos.map((url, i) => ({ numero: i + 1, url })),
      photosSante: saisie.photos_sante ?? [],
    });
  } catch (erreur) {
    console.error("Erreur photos de mortalité :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// ------------------------------------------------------------ alertes

// Les alertes ne sont pas stockées : elles se déduisent de l'état courant.
// Les recalculer ici garantit qu'elles disent la même chose que le tableau
// de bord, plutôt que de dériver dans une table à tenir à jour.
async function listeAlertes(req, res) {
  try {
    const alertes = await alertesDeLaFerme(req.utilisateur.id);

    res.json({
      alertes,
      compteurs: {
        toutes: alertes.length,
        urgentes: alertes.filter((a) => a.niveau === "urgent").length,
        aSurveiller: alertes.filter((a) => a.niveau === "surveiller").length,
      },
    });
  } catch (erreur) {
    console.error("Erreur liste des alertes :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = {
  tableauDeBord,
  detailPoulailler,
  historiqueSaisies,
  photosMortalite,
  listeAlertes,
};


