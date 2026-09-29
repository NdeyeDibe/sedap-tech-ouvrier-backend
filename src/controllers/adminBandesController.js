const pool = require("../db/pool");
const { parAdmin, differences } = require("../services/journal");
const {
  REQUETE_SAISIES,
  REQUETE_PROGRAMME,
  REQUETE_DEPENSES,
  REQUETE_STOCK,
  LIBELLE_POSTE,
  REQUETE_PHOTOS,
  originesDesPhotos,
  avecOrigine,
  libelleJour,
} = require("./proprietaireController");

// Combien de jours d'historique l'écran reçoit d'un coup. La maquette en
// montre six et propose « Voir les 35 jours » : une bande dure rarement
// plus de 45 jours, autant tout envoyer et laisser l'écran replier.
const JOURS_HISTORIQUE = 60;

// Jour à partir duquel la vente s'ouvre (même seuil que l'appli ouvrier).
const JOUR_VENTE = 25;

// Sur quoi porte une entrée du journal, pour l'écran.
const TYPE_CORRECTION = {
  bande_corrigee: "bande",
  saisie_corrigee: "saisie",
  vente_corrigee: "vente",
  vente_supprimee_admin: "vente_supprimee",
  reception_corrigee: "reception",
};

// Une date PostgreSQL en AAAA-MM-JJ, sans décalage de fuseau.
function jourISO(valeur) {
  const d = valeur instanceof Date ? valeur : new Date(valeur);
  if (Number.isNaN(d.getTime())) return "";
  const deux = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${deux(d.getMonth() + 1)}-${deux(d.getDate())}`;
}

// Correction d'une bande par SEDAP — cahier admin, section « corrections ».
//
// Pourquoi cet écran existe : l'ouvrier saisit les poussins à la création de
// la bande, une seule fois, et plus rien n'est rattrapable ensuite. Un
// retour terrain (sept. 2026) : reçus et morts à l'arrivée intervertis, et
// la bande se retrouve avec 4 sujets vivants au lieu de plusieurs centaines.
// Tout le suivi devient faux — effectifs, mortalité, bilan — sans aucun
// moyen de revenir en arrière autrement qu'en base de production.
//
// Deux règles qui tiennent tout :
//
//  1. Rien ne passe en silence. Chaque correction est inscrite au journal
//     avec l'ancienne ET la nouvelle valeur, et le propriétaire la voit sur
//     sa bande. Corriger les chiffres d'argent de quelqu'un sans le lui dire
//     est le meilleur moyen de lui faire perdre confiance dans l'appli.
//
//  2. On refuse plutôt que de casser. L'effectif de départ (reçus − morts à
//     l'arrivée) doit rester au moins égal à ce qui est déjà mort et vendu,
//     sinon effectif_restant() devient négatif et tous les écrans mentent.

// Les champs corrigeables. Tout le reste (numéro, poulailler, dates,
// statut) relève d'autres actions, avec leurs propres règles.
const CHAMPS = [
  "poussins_commandes",
  "poussins_recus",
  "morts_a_larrivee",
  "provenance",
  "souche",
  "poids_reception_g",
  "poussins_paye_par",
  "prix_unitaire_poussin",
];

// Nom lisible, pour les messages d'erreur et pour la ligne que verra le
// propriétaire.
const LIBELLES = {
  poussins_commandes: "Poussins commandés",
  poussins_recus: "Poussins reçus",
  morts_a_larrivee: "Morts à l'arrivée",
  provenance: "Provenance",
  souche: "Souche",
  poids_reception_g: "Poids à la réception",
  poussins_paye_par: "Poussins payés par",
  prix_unitaire_poussin: "Prix d'un poussin",
};

// Corps de requête (camelCase) -> colonne.
const DEPUIS_CORPS = {
  poussinsCommandes: "poussins_commandes",
  poussinsRecus: "poussins_recus",
  mortsALArrivee: "morts_a_larrivee",
  provenance: "provenance",
  souche: "souche",
  poidsReceptionG: "poids_reception_g",
  payePar: "poussins_paye_par",
  prixUnitairePoussin: "prix_unitaire_poussin",
};

// Un entier, ou null si la valeur n'est pas exploitable. Les champs
// arrivent du formulaire en chaîne de caractères.
// Absent (undefined) et vide comptent comme « pas de valeur ». Sans le test
// sur undefined, String(undefined) vaut la chaîne "undefined", non vide :
// le contrôle du motif obligatoire passait alors qu'il n'y en avait aucun.
const vide = (valeur) => valeur === null || valeur === undefined || valeur === "";

function entier(valeur) {
  if (vide(valeur)) return null;
  const n = Number(valeur);
  return Number.isInteger(n) ? n : undefined; // undefined = invalide
}

function decimal(valeur) {
  if (vide(valeur)) return null;
  const n = Number(valeur);
  return Number.isFinite(n) ? n : undefined;
}

// Le bilan d'une bande, tel que `bilans_bandes` le calcule. PostgreSQL rend
// les NUMERIC en chaînes : sans cette conversion, « 3200.00 » partirait au
// front comme du texte et s'additionnerait de travers.
function bilanChiffre(ligne) {
  if (!ligne) return null;
  return {
    dureeJours: ligne.duree_jours == null ? null : Number(ligne.duree_jours),
    morts: Number(ligne.morts ?? 0),
    vendus: Number(ligne.vendus ?? 0),
    tauxMortalite: Number(ligne.taux_mortalite ?? 0),
    totalDepenses: Number(ligne.total_depenses ?? 0),
    totalRecettes: Number(ligne.total_recettes ?? 0),
    beneficeNet: Number(ligne.benefice_net ?? 0),
    // Ce qui manque encore pour que le bilan soit complet : des sujets
    // ramassés sans prix, des réceptions sans prix, des poussins sans prix.
    // Les afficher évite qu'on prenne un bilan partiel pour un bilan final.
    sujetsSansPrix: Number(ligne.sujets_sans_prix ?? 0),
    receptionsSansPrix: Number(ligne.receptions_sans_prix ?? 0),
    poussinsSansPrix: !!ligne.poussins_sans_prix,
  };
}

function texte(valeur) {
  if (vide(valeur)) return null;
  const t = String(valeur).trim();
  return t === "" ? null : t;
}

// Applique le corps de la requête sur la ligne existante. Ne touche qu'aux
// champs réellement envoyés : un écran qui ne montre que deux champs ne doit
// pas effacer les six autres.
function fusionner(bande, corps) {
  const apres = {};
  for (const champ of CHAMPS) apres[champ] = bande[champ];

  for (const [cle, colonne] of Object.entries(DEPUIS_CORPS)) {
    if (!(cle in corps)) continue;
    const brut = corps[cle];

    if (colonne === "prix_unitaire_poussin") apres[colonne] = decimal(brut);
    else if (colonne === "provenance" || colonne === "souche" || colonne === "poussins_paye_par")
      apres[colonne] = texte(brut);
    else apres[colonne] = entier(brut);
  }
  return apres;
}

// Renvoie le message d'erreur, ou null si tout est cohérent.
// `deja` = ce qui est déjà mort et vendu sur cette bande.
function verifier(apres, deja) {
  for (const [colonne, valeur] of Object.entries(apres)) {
    if (valeur === undefined) return `${LIBELLES[colonne]} : valeur invalide.`;
  }

  const { poussins_recus: recus, morts_a_larrivee: morts, poussins_commandes: commandes } = apres;

  if (recus === null || recus <= 0) return "Poussins reçus : un nombre supérieur à 0 est attendu.";
  if (morts === null || morts < 0) return "Morts à l'arrivée : un nombre positif ou nul est attendu.";
  if (morts > recus) {
    return `Morts à l'arrivée (${morts}) ne peut pas dépasser les poussins reçus (${recus}).`;
  }
  if (commandes !== null && commandes < 0) {
    return "Poussins commandés : un nombre positif est attendu.";
  }
  if (apres.poids_reception_g !== null && apres.poids_reception_g <= 0) {
    return "Poids à la réception : un nombre de grammes supérieur à 0 est attendu.";
  }
  if (!["ouvrier", "proprietaire"].includes(apres.poussins_paye_par)) {
    return "Poussins payés par : « ouvrier » ou « proprietaire » attendu.";
  }
  if (apres.prix_unitaire_poussin !== null && apres.prix_unitaire_poussin <= 0) {
    return "Prix d'un poussin : un montant supérieur à 0 est attendu.";
  }
  // Même règle qu'à la création (contrainte poussins_prix_si_ouvrier).
  if (apres.poussins_paye_par === "ouvrier" && apres.prix_unitaire_poussin === null) {
    return "Le prix d'un poussin est obligatoire quand c'est l'ouvrier qui a payé.";
  }

  // LA règle : l'effectif de départ doit couvrir ce qui est déjà sorti.
  const depart = recus - morts;
  if (depart < deja.morts + deja.vendus) {
    return (
      `Impossible : cette bande a déjà ${deja.morts} morts et ${deja.vendus} vendus, ` +
      `soit ${deja.morts + deja.vendus} sujets. Avec ${recus} reçus et ${morts} morts à ` +
      `l'arrivée, l'effectif de départ ne serait que de ${depart}. Corrigez d'abord les ` +
      `saisies de mortalité ou les ventes.`
    );
  }

  return null;
}

// PATCH /api/admin/bandes/:id
async function corrigerBande(req, res) {
  const bandeId = Number(req.params.id);
  if (!Number.isInteger(bandeId)) {
    return res.status(400).json({ erreur: "Identifiant de bande invalide." });
  }

  const motif = texte(req.body.motif);
  if (!motif) {
    // Une correction sans raison écrite n'est pas exploitable six mois plus
    // tard, ni par SEDAP ni par le propriétaire qui la découvre.
    return res.status(400).json({ erreur: "Indiquez la raison de la correction." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT b.id, b.numero, b.poulailler_id,
              ${CHAMPS.join(", ")},
              sujets_morts(b.id) AS deja_morts,
              sujets_vendus(b.id) AS deja_vendus
         FROM bandes b
        WHERE b.id = $1
          FOR UPDATE`,
      [bandeId]
    );
    const bande = rows[0];
    if (!bande) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erreur: "Bande introuvable." });
    }

    const apres = fusionner(bande, req.body);
    const probleme = verifier(apres, {
      morts: Number(bande.deja_morts),
      vendus: Number(bande.deja_vendus),
    });
    if (probleme) {
      await client.query("ROLLBACK");
      return res.status(409).json({ erreur: probleme });
    }

    // Même précaution que pour les ventes : le prix revient en texte de
    // PostgreSQL et paraîtrait modifié à chaque correction.
    const diff = differences(
      {
        ...bande,
        prix_unitaire_poussin:
          bande.prix_unitaire_poussin === null ? null : Number(bande.prix_unitaire_poussin),
      },
      apres,
      CHAMPS
    );
    if (Object.keys(diff).length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ erreur: "Aucune modification : les valeurs sont identiques." });
    }

    await client.query(
      `UPDATE bandes SET
         poussins_commandes = $2, poussins_recus = $3, morts_a_larrivee = $4,
         provenance = $5, souche = $6, poids_reception_g = $7,
         poussins_paye_par = $8, prix_unitaire_poussin = $9
       WHERE id = $1`,
      [
        bandeId,
        apres.poussins_commandes,
        apres.poussins_recus,
        apres.morts_a_larrivee,
        apres.provenance,
        apres.souche,
        apres.poids_reception_g,
        apres.poussins_paye_par,
        apres.prix_unitaire_poussin,
      ]
    );

    await client.query("COMMIT");

    // Après le COMMIT : le journal ne fait jamais échouer l'action.
    parAdmin(req, {
      action: "bande_corrigee",
      cibleType: "bande",
      cibleId: bandeId,
      bandeId,
      details: {
        motif,
        // Libellés inclus : l'écran du propriétaire affiche la ligne sans
        // avoir à connaître les noms de colonnes.
        champs: Object.fromEntries(
          Object.entries(diff).map(([colonne, valeurs]) => [
            colonne,
            { libelle: LIBELLES[colonne], ...valeurs },
          ])
        ),
      },
    });

    // L'état recalculé, pour que l'écran affiche tout de suite le résultat.
    const { rows: etats } = await pool.query(
      `SELECT effectif_initial, morts, vendus, restant, taux_mortalite
         FROM etat_bandes WHERE bande_id = $1`,
      [bandeId]
    );

    const e = etats[0];
    res.json({
      id: bandeId,
      numero: bande.numero,
      corrections: Object.keys(diff).length,
      // NUMERIC revient de PostgreSQL en chaîne : on le rend en nombre, pour
      // que l'écran n'ait pas à y penser.
      etat: e
        ? {
            effectifInitial: e.effectif_initial,
            morts: e.morts,
            vendus: e.vendus,
            restant: e.restant,
            tauxMortalite: e.taux_mortalite == null ? 0 : Number(e.taux_mortalite),
          }
        : null,
    });
  } catch (erreur) {
    await client.query("ROLLBACK");
    console.error("Erreur correction bande :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

// GET /api/admin/bandes/:id — ce que l'écran de correction a besoin
// d'afficher : les valeurs actuelles, ce qui est déjà sorti (la limite à ne
// pas franchir), et l'historique des corrections déjà faites.
async function detailBandeAdmin(req, res) {
  const bandeId = Number(req.params.id);
  if (!Number.isInteger(bandeId)) {
    return res.status(400).json({ erreur: "Identifiant de bande invalide." });
  }

  try {
    const { rows: bandes } = await pool.query(
      `SELECT b.id, b.numero, b.statut, b.date_debut, b.date_fin,
              (now()::date - b.date_debut::date)::int + 1 AS age_jours,
              ${CHAMPS.join(", ")},
              pl.id AS poulailler_id, pl.nom AS poulailler_nom,
              f.id AS ferme_id, f.nom AS ferme_nom,
              o.prenom AS ouvrier_prenom, o.nom AS ouvrier_nom,
              o.telephone AS ouvrier_telephone,
              e.effectif_initial, e.morts, e.vendus, e.restant, e.taux_mortalite,
              coalesce((SELECT sm.mortalite FROM saisies_mortalite sm
                         WHERE sm.bande_id = b.id AND sm.date_saisie = CURRENT_DATE), 0)
                AS morts_aujourdhui
         FROM bandes b
         JOIN poulaillers pl ON pl.id = b.poulailler_id
         LEFT JOIN fermes f ON f.id = pl.ferme_id
         LEFT JOIN personnel pe
           ON pe.poulailler_id = pl.id AND pe.role = 'responsable' AND pe.fin_fonction IS NULL
         LEFT JOIN ouvriers o ON o.id = pe.ouvrier_id
         LEFT JOIN etat_bandes e ON e.bande_id = b.id
        WHERE b.id = $1`,
      [bandeId]
    );

    const b = bandes[0];
    if (!b) return res.status(404).json({ erreur: "Bande introuvable." });

    // Le reste du contenu vient des mêmes requêtes que l'écran du
    // propriétaire — c'est ce que demande le cahier admin (section IX).
    const [saisies, programme, depenses, stock, ventes, receptions, corrections, bilan] = await Promise.all([
      pool.query(REQUETE_SAISIES, [bandeId, JOURS_HISTORIQUE]),
      pool.query(REQUETE_PROGRAMME, [bandeId]),
      pool.query(REQUETE_DEPENSES, [bandeId]),
      pool.query(REQUETE_STOCK, [b.poulailler_id]),
      // Les deux listes du cahier admin : ventes à la ferme saisies par
      // l'ouvrier, et ramassages du propriétaire avec leur détail.
      pool.query(
        `SELECT v.id, v.type_vente, v.nom_client, v.telephone_client,
                v.quantite, v.prix_unitaire, v.date_vente, v.auteur_type,
                coalesce((SELECT sum(d.quantite) FROM ventes_details d WHERE d.vente_id = v.id), 0)
                  AS detaille,
                coalesce((SELECT count(*) FROM ventes_details d WHERE d.vente_id = v.id), 0)
                  AS lignes_detail
           FROM ventes v
          WHERE v.bande_id = $1
          ORDER BY v.date_vente DESC`,
        [bandeId]
      ),
      // Les réceptions de stock rattachées à cette bande (la vue les relie
      // par la date). Les poussins ont leur propre bloc, on les écarte.
      pool.query(
        `SELECT id, poste, nom, unite, quantite, prix_unitaire, provenance,
                date_reception, source
           FROM receptions_ferme
          WHERE bande_id = $1 AND origine = 'produit'
          ORDER BY date_reception DESC`,
        [bandeId]
      ),
      // Le journal nomme qui a corrigé : une trace anonyme ne sert à rien
      // quand il faut rappeler la personne pour comprendre.
      pool.query(
        `SELECT j.id, j.cree_le, j.details, j.action,
                a.prenom AS admin_prenom, a.nom AS admin_nom
           FROM journal_activite j
           LEFT JOIN admins a ON a.id = j.acteur_id AND j.acteur_type = 'admin'
          WHERE j.bande_id = $1
            AND j.action IN ('bande_corrigee', 'saisie_corrigee',
                             'vente_corrigee', 'vente_supprimee_admin',
                             'reception_corrigee')
          ORDER BY j.cree_le DESC
          LIMIT 50`,
        [bandeId]
      ),
      // Le bilan chiffré, pris tel quel dans `bilans_bandes` — la même vue
      // que l'écran Finances du propriétaire. Le refaire ici ferait courir
      // le risque d'un écart de quelques francs entre son bilan et celui de
      // SEDAP : discussion impossible à trancher au téléphone.
      pool.query(
        `SELECT duree_jours, morts, vendus, taux_mortalite,
                total_depenses, total_recettes, sujets_sans_prix, benefice_net,
                receptions_sans_prix, poussins_sans_prix
           FROM bilans_bandes WHERE bande_id = $1`,
        [bandeId]
      ),
    ]);

    // Les jours déjà corrigés, pour l'icône crayon de l'historique.
    const joursCorriges = new Set(
      corrections.rows
        .filter((c) => c.action === "saisie_corrigee" && c.details?.date)
        .map((c) => String(c.details.date).slice(0, 10))
    );

    const aujourdhui = new Date().toISOString().slice(0, 10);
    const totalDepenses = depenses.rows.reduce((t, d) => t + Number(d.cout), 0);

    res.json({
      bande: {
        id: b.id,
        numero: b.numero,
        statut: b.statut,
        dateDebut: b.date_debut,
        dateFin: b.date_fin,
        ageJours: Number(b.age_jours),
        // Le bouton « Démarrer la vente » s'ouvre à J25 côté ouvrier.
        ventePossibleDepuis: JOUR_VENTE,
        poussinsCommandes: b.poussins_commandes,
        poussinsRecus: b.poussins_recus,
        mortsALArrivee: b.morts_a_larrivee,
        provenance: b.provenance,
        souche: b.souche,
        poidsReceptionG: b.poids_reception_g,
        payePar: b.poussins_paye_par,
        prixUnitairePoussin: b.prix_unitaire_poussin == null ? null : Number(b.prix_unitaire_poussin),
      },
      poulailler: { id: b.poulailler_id, nom: b.poulailler_nom },
      ferme: { id: b.ferme_id, nom: b.ferme_nom },
      responsable: b.ouvrier_prenom
        ? { prenom: b.ouvrier_prenom, nom: b.ouvrier_nom, telephone: b.ouvrier_telephone }
        : null,

      etat: {
        effectifInitial: b.effectif_initial,
        morts: b.morts,
        mortsAujourdhui: Number(b.morts_aujourdhui),
        vendus: b.vendus,
        restant: b.restant,
        tauxMortalite: b.taux_mortalite == null ? 0 : Number(b.taux_mortalite),
      },

      // Maquette 18 — le bilan de la bande, identique à celui du
      // propriétaire. Une bande en cours en a un aussi : il est partiel,
      // l'écran le dit.
      bilan: bilanChiffre(bilan.rows[0]),

      // Un jour se verrouille au changement de jour : passé cette limite,
      // l'ouvrier ne peut plus y toucher, seul SEDAP le peut.
      saisies: saisies.rows.map((s) => {
        const jour = jourISO(s.date_saisie);
        return {
          date: s.date_saisie,
          morts: Number(s.mortalite),
          sacs: Number(s.sacs),
          kg: Number(s.kg),
          etat: s.etat ?? "bien",
          aVocal: s.a_vocal ?? false,
          photos: Number(s.nb_photos),
          verrouillee: jour !== aujourdhui,
          corrigee: joursCorriges.has(jour),
        };
      }),

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
        total: totalDepenses,
      },

      ventes: ventes.rows.map((v) => ({
        id: v.id,
        type: v.type_vente,
        client: v.nom_client,
        telephone: v.telephone_client,
        quantite: Number(v.quantite),
        prixUnitaire: v.prix_unitaire === null ? null : Number(v.prix_unitaire),
        montant: v.prix_unitaire === null ? null : Number(v.quantite) * Number(v.prix_unitaire),
        date: v.date_vente,
        auteur: v.auteur_type,
        // Un ramassage se chiffre ligne par ligne : tant que le détail est
        // incomplet, ces sujets ne comptent pas dans les recettes.
        detaille: Number(v.detaille),
        lignesDetail: Number(v.lignes_detail),
      })),

      receptions: receptions.rows.map((r) => ({
        id: r.id,
        poste: r.poste,
        nom: r.nom,
        unite: r.unite,
        quantite: Number(r.quantite),
        prixUnitaire: r.prix_unitaire === null ? null : Number(r.prix_unitaire),
        montant: r.prix_unitaire === null ? null : Number(r.quantite) * Number(r.prix_unitaire),
        provenance: r.provenance,
        date: r.date_reception,
        // Qui a payé : l'ouvrier saisit son prix, le propriétaire chiffre
        // la sienne plus tard depuis son écran Réceptions.
        payePar: r.source,
      })),

      stock: stock.rows.map((s) => ({
        produitId: s.produit_id,
        varianteId: s.variante_id,
        nom: s.nom,
        unite: s.unite,
        quantite: Number(s.quantite),
      })),

      corrections: corrections.rows.map((c) => ({
        id: c.id,
        le: c.cree_le,
        type: TYPE_CORRECTION[c.action] ?? "bande",
        // Le jour concerné, pour les corrections de saisie.
        date: c.details?.date ?? null,
        par: [c.admin_prenom, c.admin_nom].filter(Boolean).join(" ") || "SEDAP",
        motif: c.details?.motif ?? null,
        champs: Object.entries(c.details?.champs ?? {}).map(([colonne, v]) => ({
          cle: colonne,
          libelle: v.libelle ?? colonne,
          avant: v.avant,
          apres: v.apres,
        })),
      })),
    });
  } catch (erreur) {
    console.error("Erreur détail bande admin :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// ------------------------------------------- correction d'une saisie

// PATCH /api/admin/bandes/:id/saisies/:date
//
// Une journée se verrouille au changement de jour : l'ouvrier ne peut plus
// y revenir, et c'était jusqu'ici définitif. Une faute de frappe (30 morts
// au lieu de 3) restait donc dans les chiffres pour toujours.
//
// Ce qui se corrige : la mortalité du jour, l'état de santé, et les
// quantités d'aliment. Les photos et le vocal ne se corrigent pas — ce sont
// des preuves, pas des valeurs.
async function corrigerSaisie(req, res) {
  const bandeId = Number(req.params.id);
  const jour = String(req.params.date ?? "");

  if (!Number.isInteger(bandeId)) {
    return res.status(400).json({ erreur: "Identifiant de bande invalide." });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(jour)) {
    return res.status(400).json({ erreur: "Date attendue au format AAAA-MM-JJ." });
  }

  const motif = texte(req.body.motif);
  if (!motif) {
    return res.status(400).json({ erreur: "Indiquez la raison de la correction." });
  }

  const mortalite = "mortalite" in req.body ? entier(req.body.mortalite) : undefined;
  const etat = "etat" in req.body ? texte(req.body.etat) : undefined;

  if (mortalite === undefined && etat === undefined) {
    return res.status(400).json({ erreur: "Rien à corriger." });
  }
  if (mortalite !== undefined && (mortalite === null || mortalite < 0)) {
    return res.status(400).json({ erreur: "Mortalité : un nombre positif ou nul est attendu." });
  }
  if (etat !== undefined && !["bien", "anormal", "urgent"].includes(etat)) {
    return res.status(400).json({ erreur: "État : « bien », « anormal » ou « urgent » attendu." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: avant } = await client.query(
      `SELECT sm.mortalite, ss.etat
         FROM saisies_mortalite sm
         LEFT JOIN saisies_sante ss
           ON ss.bande_id = sm.bande_id AND ss.date_saisie = sm.date_saisie
        WHERE sm.bande_id = $1 AND sm.date_saisie = $2::date
          FOR UPDATE OF sm`,
      [bandeId, jour]
    );
    const ligne = avant[0];
    if (!ligne) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erreur: "Aucune saisie ce jour-là pour cette bande." });
    }

    // Même garde-fou que pour la bande : la mortalité corrigée ne doit pas
    // faire passer l'effectif restant sous zéro.
    if (mortalite !== undefined) {
      const { rows: etats } = await client.query(
        `SELECT effectif_initial(b.id) AS depart,
                sujets_morts(b.id) AS morts,
                sujets_vendus(b.id) AS vendus
           FROM bandes b WHERE b.id = $1`,
        [bandeId]
      );
      const e = etats[0];
      const mortsApres = Number(e.morts) - Number(ligne.mortalite) + mortalite;
      if (Number(e.depart) - mortsApres - Number(e.vendus) < 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          erreur:
            `Impossible : avec ${mortalite} morts ce jour-là, le total des morts ` +
            `(${mortsApres}) et des vendus (${e.vendus}) dépasserait l'effectif de ` +
            `départ (${e.depart}).`,
        });
      }

      await client.query(
        "UPDATE saisies_mortalite SET mortalite = $3 WHERE bande_id = $1 AND date_saisie = $2::date",
        [bandeId, jour, mortalite]
      );
    }

    if (etat !== undefined) {
      // La saisie santé peut manquer (journée sans passage) : on la crée.
      await client.query(
        `INSERT INTO saisies_sante (bande_id, date_saisie, etat)
         VALUES ($1, $2::date, $3)
         ON CONFLICT (bande_id, date_saisie) DO UPDATE SET etat = EXCLUDED.etat`,
        [bandeId, jour, etat]
      );
    }

    const diff = differences(
      { mortalite: ligne.mortalite, etat: ligne.etat },
      {
        ...(mortalite !== undefined ? { mortalite } : {}),
        ...(etat !== undefined ? { etat } : {}),
      },
      ["mortalite", "etat"]
    );

    if (Object.keys(diff).length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ erreur: "Aucune modification : les valeurs sont identiques." });
    }

    await client.query("COMMIT");

    parAdmin(req, {
      action: "saisie_corrigee",
      cibleType: "saisie",
      cibleId: bandeId,
      bandeId,
      details: {
        motif,
        date: jour,
        champs: Object.fromEntries(
          Object.entries(diff).map(([colonne, valeurs]) => [
            colonne,
            { libelle: LIBELLES_SAISIE[colonne] ?? colonne, ...valeurs },
          ])
        ),
      },
    });

    res.json({ bandeId, date: jour, corrections: Object.keys(diff).length });
  } catch (erreur) {
    await client.query("ROLLBACK");
    console.error("Erreur correction saisie :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

const LIBELLES_SAISIE = { mortalite: "Mortalité", etat: "État de santé" };


// GET /api/admin/bandes/:bandeId/saisies/:date/photos
//
// Les photos de mortalité et le vocal de santé d'une journée. Même contenu
// que chez le propriétaire, même requête — mais sans vérifier à qui
// appartient la bande : c'est tout l'objet de l'interface admin.
//
// SEDAP en a besoin avant de corriger une saisie : un chiffre de mortalité
// aberrant se juge sur les photos, pas sur le chiffre seul.
async function photosSaisieAdmin(req, res) {
  const bandeId = Number(req.params.bandeId);
  const { date } = req.params;

  if (!Number.isInteger(bandeId)) {
    return res.status(400).json({ erreur: "Identifiant de bande invalide." });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ erreur: "Date attendue au format AAAA-MM-JJ." });
  }

  try {
    const { rows } = await pool.query(REQUETE_PHOTOS, [bandeId, date]);
    if (rows.length === 0) {
      return res.status(404).json({ erreur: "Aucune saisie à cette date." });
    }

    const saisie = rows[0];
    const photos = saisie.photos ?? [];
    const photosSante = saisie.photos_sante ?? [];
    const connues = await originesDesPhotos([...photos, ...photosSante]);

    res.json({
      date: saisie.date_saisie,
      libelle: libelleJour(saisie.date_saisie),
      morts: Number(saisie.mortalite),
      etat: saisie.etat ?? "bien",
      // vocal_url est nul sur les saisies antérieures à son ajout : le
      // vocal a existé, mais n'a jamais quitté le téléphone de l'ouvrier.
      aVocal: saisie.a_vocal ?? false,
      vocalUrl: saisie.vocal_url ?? null,
      photos: avecOrigine(photos, connues),
      photosSante: avecOrigine(photosSante, connues),
    });
  } catch (erreur) {
    console.error("Erreur photos de saisie (admin) :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = {
  corrigerBande,
  corrigerSaisie,
  detailBandeAdmin,
  photosSaisieAdmin,
  LIBELLES_BANDE: LIBELLES,
};
