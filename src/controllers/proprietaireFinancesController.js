const pool = require("../db/pool");
const { resumeAnnuel, totalSalaires, fraisDuMois, totalFrais } =
  require("../utils/finances");

// Chaque requête part du propriétaire connecté et remonte par sa ferme :
// aucun identifiant reçu du client ne sert de point d'entrée.

// ------------------------------------------------ bilans par bande

const REQUETE_POULAILLERS_BILANS = `
  SELECT
    pl.id, pl.nom,
    pe.prenom AS ouvrier_prenom,
    count(b.id) AS nombre_bandes
  FROM poulaillers pl
  JOIN fermes f ON f.id = pl.ferme_id
  LEFT JOIN bandes b ON b.poulailler_id = pl.id
  LEFT JOIN personnel pe
    ON pe.poulailler_id = pl.id AND pe.role = 'responsable' AND pe.fin_fonction IS NULL
  WHERE f.proprietaire_id = $1
  GROUP BY pl.id, pl.nom, pe.prenom
  ORDER BY pl.id
`;

async function poulaillersBilans(req, res) {
  try {
    const { rows } = await pool.query(REQUETE_POULAILLERS_BILANS, [
      req.utilisateur.id,
    ]);

    res.json(
      rows.map((p) => ({
        id: p.id,
        nom: p.nom,
        ouvrier: p.ouvrier_prenom,
        nombreBandes: Number(p.nombre_bandes),
      }))
    );
  } catch (erreur) {
    console.error("Erreur poulaillers bilans :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

const REQUETE_BANDES_POULAILLER = `
  SELECT bb.*
    FROM bilans_bandes bb
    JOIN poulaillers pl ON pl.id = bb.poulailler_id
    JOIN fermes f ON f.id = pl.ferme_id
   WHERE f.proprietaire_id = $1 AND pl.id = $2
   ORDER BY bb.numero DESC
`;

// Un bilan est complet quand plus aucun prix ne manque : sujets ramassés
// pas encore détaillés, réceptions payées par le propriétaire pas encore
// chiffrées. Tant qu'il en manque, le bénéfice affiché serait faux : l'écran
// montre alors un bilan provisoire et la liste de ce qu'il reste à chiffrer.
const bilanComplet = (b) =>
  Number(b.sujets_sans_prix) === 0 && Number(b.receptions_sans_prix) === 0;

async function historiqueBandes(req, res) {
  const { poulaillerId } = req.params;

  try {
    const { rows } = await pool.query(REQUETE_BANDES_POULAILLER, [
      req.utilisateur.id,
      poulaillerId,
    ]);

    res.json(
      rows.map((b) => ({
        id: b.bande_id,
        numero: b.numero,
        statut: b.statut,
        dureeJours: Number(b.duree_jours),
        // Le bilan n'a de sens qu'une fois la bande close : tant que la
        // vente court, dépenses et recettes bougent encore chaque jour.
        beneficeNet: b.statut === "terminee" ? Number(b.benefice_net) : null,
        complet: bilanComplet(b),
        mortalite: b.taux_mortalite ? Number(b.taux_mortalite) : 0,
      }))
    );
  } catch (erreur) {
    console.error("Erreur historique des bandes :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// ------------------------------------------------ détail d'un bilan

const LIBELLE_POSTE = {
  aliment: "Aliment",
  gaz: "Gaz",
  litiere: "Litière",
  vitamines: "Vitamines",
  antistress: "Antistress",
  vaccin: "Médicaments & vaccins",
  autres: "Autres produits",
};

async function detailBilan(req, res) {
  const { bandeId } = req.params;

  try {
    const { rows } = await pool.query(
      `SELECT bb.*, pl.nom AS poulailler_nom,
              b.poussins_recus, b.morts_a_larrivee
         FROM bilans_bandes bb
         JOIN bandes b ON b.id = bb.bande_id
         JOIN poulaillers pl ON pl.id = bb.poulailler_id
         JOIN fermes f ON f.id = pl.ferme_id
        WHERE bb.bande_id = $1 AND f.proprietaire_id = $2`,
      [bandeId, req.utilisateur.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ erreur: "Bilan introuvable." });
    }

    const bilan = rows[0];

    const [depenses, ventes] = await Promise.all([
      pool.query(
        "SELECT poste, quantite, cout FROM depenses_bandes WHERE bande_id = $1 ORDER BY poste",
        [bandeId]
      ),
      // Le registre : ventes à la ferme, et lignes de détail des ramassages.
      // Un lot brut n'y figure pas — il n'a pas encore de prix.
      pool.query(
        `SELECT v.nom_client AS client, v.telephone_client AS telephone,
                v.quantite, v.prix_unitaire, v.date_vente AS date,
                v.auteur_type, NULL::text AS ramasseur
           FROM ventes v
          WHERE v.bande_id = $1 AND v.type_vente = 'ferme'
          UNION ALL
         SELECT d.nom_client, d.telephone_client,
                d.quantite, d.prix_unitaire, d.cree_le,
                'proprietaire', v.nom_client
           FROM ventes_details d
           JOIN ventes v ON v.id = d.vente_id
          WHERE v.bande_id = $1
          ORDER BY date DESC`,
        [bandeId]
      ),
    ]);

    res.json({
      bandeId: Number(bandeId),
      poulaillerId: bilan.poulailler_id,
      poulailler: bilan.poulailler_nom,
      numero: bilan.numero,
      statut: bilan.statut,
      dureeJours: Number(bilan.duree_jours),

      beneficeNet: Number(bilan.benefice_net),
      totalDepenses: Number(bilan.total_depenses),
      totalRecettes: Number(bilan.total_recettes),
      sujetsSansPrix: Number(bilan.sujets_sans_prix),
      // Réceptions sans prix : le total des dépenses est incomplet tant
      // qu'elles ne sont pas chiffrées.
      receptionsSansPrix: Number(bilan.receptions_sans_prix),
      complet: bilanComplet(bilan),

      mortalite: {
        sujets: Number(bilan.morts),
        pourcentage: bilan.taux_mortalite ? Number(bilan.taux_mortalite) : 0,
      },

      reception: {
        recus: Number(bilan.poussins_recus),
        mortsArrivee: Number(bilan.morts_a_larrivee),
      },

      depenses: depenses.rows.map((d) => ({
        poste: d.poste,
        libelle: LIBELLE_POSTE[d.poste] ?? d.poste,
        quantite: Number(d.quantite),
        cout: Number(d.cout),
      })),

      ventes: ventes.rows.map((v) => ({
        client: v.client,
        telephone: v.telephone,
        quantite: Number(v.quantite),
        prixUnitaire: Number(v.prix_unitaire),
        montant: Number(v.quantite) * Number(v.prix_unitaire),
        date: v.date,
        auteur: v.auteur_type,
        ramasseur: v.ramasseur,
      })),
    });
  } catch (erreur) {
    console.error("Erreur détail du bilan :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// ------------------------------------------------ charges mensuelles

async function fermeDu(proprietaireId) {
  const { rows } = await pool.query(
    "SELECT id, nom FROM fermes WHERE proprietaire_id = $1",
    [proprietaireId]
  );
  return rows[0] ?? null;
}

async function chargesMensuelles(req, res) {
  try {
    const ferme = await fermeDu(req.utilisateur.id);
    if (!ferme) return res.status(404).json({ erreur: "Aucune ferme." });

    const [personnel, frais] = await Promise.all([
      pool.query(
        `SELECT pe.id, pe.role, pe.prenom, pe.telephone, pe.salaire,
                pe.prise_fonction, pe.poulailler_id, pl.nom AS poulailler_nom
           FROM personnel pe
           LEFT JOIN poulaillers pl ON pl.id = pe.poulailler_id
          WHERE pe.ferme_id = $1 AND pe.fin_fonction IS NULL
          ORDER BY pe.role, pe.id`,
        [ferme.id]
      ),
      pool.query(
        `SELECT f.id, f.description, f.montant, f.date_depense,
                f.poulailler_id, pl.nom AS poulailler_nom
           FROM frais f
           LEFT JOIN poulaillers pl ON pl.id = f.poulailler_id
          WHERE f.ferme_id = $1
          ORDER BY f.date_depense DESC`,
        [ferme.id]
      ),
    ]);

    const maintenant = new Date();
    const duMois = fraisDuMois(
      frais.rows,
      maintenant.getFullYear(),
      maintenant.getMonth()
    );

    res.json({
      ouvriers: personnel.rows.map((p) => ({
        id: p.id,
        role: p.role,
        prenom: p.prenom,
        telephone: p.telephone,
        // Nul tant que le propriétaire ne l'a pas fixé : le compte du
        // responsable existe déjà, mais ne pèse pas encore.
        salaire: p.salaire === null ? null : Number(p.salaire),
        priseFonction: p.prise_fonction,
        poulaillerId: p.poulailler_id,
        poulailler: p.poulailler_nom,
      })),
      totalSalaires: totalSalaires(personnel.rows),

      fraisDuMois: duMois.map((f) => ({
        id: f.id,
        description: f.description,
        montant: Number(f.montant),
        date: f.date_depense,
        poulaillerId: f.poulailler_id,
        poulailler: f.poulailler_nom,
      })),
      totalFrais: totalFrais(duMois),
    });
  } catch (erreur) {
    console.error("Erreur charges mensuelles :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// -------------------------------------------------- résumé annuel

async function resumeAnnuelFerme(req, res) {
  const annee = Number(req.query.annee) || new Date().getFullYear();

  try {
    const ferme = await fermeDu(req.utilisateur.id);
    if (!ferme) return res.status(404).json({ erreur: "Aucune ferme." });

    const [bandes, personnel, frais] = await Promise.all([
      // Seules les bandes closes dans l'année : une bande en cours n'a pas
      // de bénéfice arrêté.
      pool.query(
        `SELECT bb.benefice_net
           FROM bilans_bandes bb
           JOIN poulaillers pl ON pl.id = bb.poulailler_id
          WHERE pl.ferme_id = $1
            AND bb.statut = 'terminee'
            AND extract(year FROM bb.date_fin) = $2`,
        [ferme.id, annee]
      ),
      pool.query(
        "SELECT salaire, prise_fonction, fin_fonction FROM personnel WHERE ferme_id = $1",
        [ferme.id]
      ),
      pool.query(
        "SELECT montant, date_depense FROM frais WHERE ferme_id = $1",
        [ferme.id]
      ),
    ]);

    const maintenant = new Date();
    const jusquAuMois =
      annee === maintenant.getFullYear() ? maintenant.getMonth() : 11;

    const resume = resumeAnnuel({
      bandes: bandes.rows,
      personnel: personnel.rows,
      frais: frais.rows,
      annee,
      jusquAuMois,
    });

    res.json({ annee, ...resume });
  } catch (erreur) {
    console.error("Erreur résumé annuel :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = {
  poulaillersBilans,
  historiqueBandes,
  detailBilan,
  chargesMensuelles,
  resumeAnnuelFerme,
};
