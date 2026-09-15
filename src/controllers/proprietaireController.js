const pool = require("../db/pool");
const {
  alertesBande,
  statutBande,
  kgDistribues,
} = require("../utils/alertes");

// Tout ce que le tableau de bord affiche, en une requête par poulailler
// évitée : on rapatrie l'essentiel d'un coup, puis on applique les seuils
// en mémoire. Les effectifs viennent des vues etat_bandes et recettes_bandes,
// pour que la base reste seule juge de « combien il en reste ».
const REQUETE_TABLEAU_DE_BORD = `
  SELECT
    pl.id                AS poulailler_id,
    pl.nom               AS poulailler_nom,
    b.id                 AS bande_id,
    b.numero             AS bande_numero,
    b.statut,
    b.date_debut,
    -- Le jour du démarrage est J1, pas J0 : une différence de dates seule
    -- donnerait zéro le jour même, ce qui n'existe pas dans l'élevage.
    (current_date - b.date_debut::date + 1) AS age_jours,
    b.poussins_commandes,
    b.poussins_recus,
    b.morts_a_larrivee,
    e.morts,
    e.vendus,
    e.restant,
    e.taux_mortalite,
    r.sujets_sans_prix,

    -- Ventes par mode d'écoulement : un ramassage attend encore son prix,
    -- une vente à la ferme est close. Le propriétaire ne fait pas la même
    -- chose dans les deux cas.
    coalesce((
      SELECT sum(v.quantite) FROM ventes v
       WHERE v.bande_id = b.id AND v.type_vente = 'ramassage'
    ), 0) AS ramasses,
    coalesce((
      SELECT sum(v.quantite) FROM ventes v
       WHERE v.bande_id = b.id AND v.type_vente = 'ferme'
    ), 0) AS vendus_ferme,

    -- Mortalité du jour et des trois jours précédents, pour les règles
    -- de doublement et de hausse continue.
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

    -- État de santé signalé par l'ouvrier aujourd'hui : « urgent » déclenche
    -- l'alerte quel que soit le taux.
    coalesce((
      SELECT ss.etat FROM saisies_sante ss
       WHERE ss.bande_id = b.id AND ss.date_saisie = current_date
    ), 'bien') AS etat_ouvrier,

    -- Stock d'aliment restant, toutes variantes confondues.
    coalesce((
      SELECT sum(sp.quantite) FROM stock_produits sp
       WHERE sp.poulailler_id = pl.id AND sp.produit_id = 'aliment'
    ), 0) AS aliment_restant_kg,

    -- Ce qui a été distribué hier, base du calcul d'autonomie.
    coalesce((
      SELECT sum(sa.sacs) FROM saisies_alimentation sa
       WHERE sa.bande_id = b.id AND sa.date_saisie = current_date - 1
    ), 0) AS sacs_hier,
    coalesce((
      SELECT sum(sa.kg_supplementaires) FROM saisies_alimentation sa
       WHERE sa.bande_id = b.id AND sa.date_saisie = current_date - 1
    ), 0) AS kg_hier,

    -- Ouvrier responsable : le propriétaire doit pouvoir l'appeler.
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
  ORDER BY pl.id
`;

// Le programme de vaccination n'a pas sa place dans la requête ci-dessus :
// on ne veut que le prochain vaccin dû et non confirmé.
const REQUETE_PROCHAIN_VACCIN = `
  SELECT bande_id, vaccin_nom, jour_bande, date_saisie
    FROM vaccinations
   WHERE bande_id = ANY($1)
   ORDER BY jour_bande
`;

function construireBande(ligne) {
  const distribueVeilleKg = kgDistribues({
    sacs: ligne.sacs_hier,
    kg_supplementaires: ligne.kg_hier,
  });

  return {
    mortsDuJour: Number(ligne.morts_du_jour),
    sujetsVivants: Number(ligne.restant),
    ageJours: Number(ligne.age_jours),
    mortsJoursPrecedents: (ligne.morts_precedents || []).map(Number),
    etatOuvrier: ligne.etat_ouvrier,
    stockRestantKg: Number(ligne.aliment_restant_kg),
    distribueVeilleKg,
    prochainVaccin: ligne.prochainVaccin ?? null,
  };
}

async function tableauDeBord(req, res) {
  try {
    const { rows } = await pool.query(REQUETE_TABLEAU_DE_BORD, [
      req.utilisateur.id,
    ]);

    // Un poulailler sans bande active n'a rien à surveiller.
    const bandesActives = rows.filter((l) => l.bande_id).map((l) => l.bande_id);

    let vaccinsParBande = {};
    if (bandesActives.length > 0) {
      const vaccins = await pool.query(REQUETE_PROCHAIN_VACCIN, [bandesActives]);
      vaccinsParBande = vaccins.rows.reduce((acc, v) => {
        acc[v.bande_id] = acc[v.bande_id] ?? [];
        acc[v.bande_id].push(v);
        return acc;
      }, {});
    }

    const poulaillers = rows.map((ligne) => {
      if (!ligne.bande_id) {
        return {
          id: ligne.poulailler_id,
          nom: ligne.poulailler_nom,
          bandeActive: null,
          alertes: [],
          statut: "ok",
        };
      }

      const bande = construireBande(ligne);
      const alertes = alertesBande(bande);

      return {
        id: ligne.poulailler_id,
        nom: ligne.poulailler_nom,
        ouvrier: ligne.ouvrier_prenom
          ? { nom: ligne.ouvrier_prenom, telephone: ligne.ouvrier_telephone }
          : null,
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
        alertes,
        statut: statutBande(bande),
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
const REQUETE_DETAIL = REQUETE_TABLEAU_DE_BORD.replace(
  "WHERE f.proprietaire_id = $1",
  "WHERE f.proprietaire_id = $1 AND pl.id = $2"
);

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
    const { rows } = await pool.query(REQUETE_DETAIL, [
      req.utilisateur.id,
      poulaillerId,
    ]);

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

    // Seuls les vaccins déclenchent l'alerte du CDC : les traitements
    // s'étalent sur plusieurs jours et relèvent du confort de suivi.
    const vaccinEnRetard = programme.rows.find(
      (p) => p.type === "vaccin" && p.en_retard
    );

    const bande = construireBande({
      ...ligne,
      prochainVaccin: vaccinEnRetard
        ? {
            nom: vaccinEnRetard.nom,
            jour: vaccinEnRetard.jour_debut,
            datePrevue: vaccinEnRetard.date_limite,
            confirme: false,
          }
        : null,
    });

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

      alertes: alertesBande(bande),
      statut: statutBande(bande),
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
         ss.etat, ss.a_vocal, ss.photos AS photos_sante
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
      // Le CDC prévoyait un texte ; la maquette montre un vocal. Le champ
      // a_vocal dit seulement qu'il en existe un — l'adresse du fichier
      // viendra quand l'envoi des vocaux sera en place côté ouvrier.
      aVocal: saisie.a_vocal ?? false,
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
    const { rows } = await pool.query(REQUETE_TABLEAU_DE_BORD, [
      req.utilisateur.id,
    ]);

    const actives = rows.filter((l) => l.bande_id);

    let programmes = {};
    if (actives.length > 0) {
      const { rows: lignes } = await pool.query(
        `SELECT bande_id, nom, jour_debut, date_limite
           FROM programme_bandes
          WHERE bande_id = ANY($1) AND type = 'vaccin' AND en_retard
          ORDER BY ordre`,
        [actives.map((l) => l.bande_id)]
      );
      programmes = lignes.reduce((acc, v) => {
        acc[v.bande_id] = acc[v.bande_id] ?? v;
        return acc;
      }, {});
    }

    const alertes = actives.flatMap((ligne) => {
      const enRetard = programmes[ligne.bande_id];

      const bande = construireBande({
        ...ligne,
        prochainVaccin: enRetard
          ? {
              nom: enRetard.nom,
              jour: enRetard.jour_debut,
              datePrevue: enRetard.date_limite,
              confirme: false,
            }
          : null,
      });

      return alertesBande(bande).map((alerte) => ({
        ...alerte,
        poulailler: {
          id: ligne.poulailler_id,
          nom: ligne.poulailler_nom,
        },
        ouvrier: ligne.ouvrier_prenom
          ? { nom: ligne.ouvrier_prenom, telephone: ligne.ouvrier_telephone }
          : null,
      }));
    });

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


