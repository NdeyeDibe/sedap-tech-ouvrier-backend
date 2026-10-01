const pool = require("../db/pool");
const { parProprietaire } = require("../services/journal");

// Réceptions de stock vues par le propriétaire.
//
// L'ouvrier déclare chaque réception en indiquant qui l'a payée. Quand c'est
// le propriétaire qui a commandé et réglé chez le fournisseur, l'ouvrier ne
// saisit que la quantité reçue : le prix manque, et c'est au propriétaire de
// le compléter ici — comme il chiffre les sujets partis en ramassage.
//
// Le rattachement d'une réception à une bande se fait par date (vue
// receptions_ferme), jamais recalculé ici.

// 'poussins' : les poussins d'une bande, identifiés par la bande (019).
const ORIGINES = { produit: "stock_receptions", autre: "stock_autres_produits", poussins: "bandes" };

const LIBELLE_POSTE = {
  poussins: "Poussins",
  aliment: "Aliment",
  gaz: "Gaz",
  litiere: "Litière",
  vitamines: "Vitamines",
  antistress: "Antistress",
  vaccin: "Médicaments & vaccins",
  autres: "Autres produits",
};

// L'aliment est suivi en kg dans le stock, mais il s'achète au sac : le
// propriétaire connaît le prix du SAC, pas celui du kg. On lui présente donc
// l'aliment en sacs, et on reconvertit en kg le prix qu'il saisit. Sans ça,
// il tape le prix du sac là où la base attend celui du kg : dépense × 50.
// Même poids que l'appli ouvrier (règle CDC ouvrier VII : 1 sac = 50 kg).
const POIDS_SAC_KG = 50;
const enSacs = (ligne) => ligne.origine === "produit" && ligne.poste === "aliment";

// Même raison pour les vaccins : le stock est en doses, mais on achète des
// flacons de 500 ou 1 000 doses. Sans cette conversion, le propriétaire
// taperait le prix d'un flacon là où la base attend celui d'une dose, et la
// dépense serait multipliée par mille.
const dosesParFlacon = (ligne) =>
  ligne.origine === "produit" && ligne.doses_par_unite ? Number(ligne.doses_par_unite) : null;

async function poulaillerAutorise(poulaillerId, proprietaireId) {
  const { rows } = await pool.query(
    `SELECT pl.id, pl.nom
       FROM poulaillers pl
       JOIN fermes f ON f.id = pl.ferme_id
      WHERE pl.id = $1 AND f.proprietaire_id = $2`,
    [poulaillerId, proprietaireId]
  );
  return rows[0] ?? null;
}

function enveloppe(ligne) {
  const prixBase = ligne.prix_unitaire === null ? null : Number(ligne.prix_unitaire);
  const sacs = enSacs(ligne);
  const doses = dosesParFlacon(ligne);

  // Combien d'unités de stock dans ce que le propriétaire a acheté : 50 kg
  // par sac, 1 000 doses par flacon, 1 partout ailleurs.
  const parAchat = sacs ? POIDS_SAC_KG : (doses ?? 1);

  // Le montant ne change pas : seule l'unité d'affichage change.
  const montant = prixBase === null ? null : Number(ligne.quantite) * prixBase;
  const quantite = Number(ligne.quantite) / parAchat;
  const prix = prixBase === null ? null : prixBase * parAchat;

  return {
    origine: ligne.origine,
    id: ligne.id,
    poste: ligne.poste,
    libelle: LIBELLE_POSTE[ligne.poste] ?? ligne.poste,
    nom: ligne.nom,
    unite: sacs ? "sacs" : doses ? "flacons" : ligne.unite,
    // Unité du prix saisi : « Fcfa / sac de 50 kg », « Fcfa / flacon de
    // 1 000 doses ». C'est ce que le propriétaire a sous les yeux sur sa
    // facture ; lui demander un prix à la dose serait absurde.
    unitePrix: sacs
      ? `sac de ${POIDS_SAC_KG} kg`
      : doses
        ? `flacon de ${doses} doses`
        : ligne.origine === "poussins" ? "poussin" : ligne.unite,
    quantite,
    prixUnitaire: prix,
    montant,
    provenance: ligne.provenance,
    date: ligne.date_reception,
    payePar: ligne.source,
    bandeId: ligne.bande_id,
    bandeNumero: ligne.bande_numero,
    prixManquant: prix === null,
  };
}

// ------------------------------------------------------ le registre

// Toutes les réceptions d'un poulailler, de la plus récente à la plus
// ancienne. Le filtre ?bande=ID limite à une bande, pour l'ouvrir depuis un
// bilan ; sans filtre, on voit aussi les réceptions faites entre deux bandes,
// qui n'apparaissent dans aucun bilan.
async function registreReceptions(req, res) {
  const { poulaillerId } = req.params;
  const { bande } = req.query;

  try {
    const poulailler = await poulaillerAutorise(poulaillerId, req.utilisateur.id);
    if (!poulailler) {
      return res.status(404).json({ erreur: "Poulailler introuvable." });
    }

    const { rows } = await pool.query(
      // La jointure rapporte la contenance des flacons : le stock des
      // vaccins est en doses, mais le propriétaire a payé des flacons.
      `SELECT r.*, b.numero AS bande_numero, sr.doses_par_unite
         FROM receptions_ferme r
         LEFT JOIN bandes b ON b.id = r.bande_id
         LEFT JOIN stock_receptions sr
           ON sr.id = r.id AND r.origine = 'produit'
        WHERE r.poulailler_id = $1
          AND ($2::int IS NULL OR r.bande_id = $2)
        ORDER BY r.date_reception DESC`,
      [poulaillerId, bande ? Number(bande) : null]
    );

    const receptions = rows.map(enveloppe);
    const sansPrix = receptions.filter((r) => r.prixManquant);

    res.json({
      poulailler: { id: poulailler.id, nom: poulailler.nom },
      receptions,
      totaux: {
        nombre: receptions.length,
        // Ce que le propriétaire a réellement déboursé : les achats de
        // l'ouvrier lui sont remboursés, mais ce sont deux flux distincts.
        depenseConnue: receptions.reduce((t, r) => t + (r.montant ?? 0), 0),
        sansPrix: sansPrix.length,
      },
    });
  } catch (erreur) {
    console.error("Erreur registre des réceptions :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// -------------------------------------------- renseigner un prix manquant

async function renseignerPrix(req, res) {
  const { origine, receptionId } = req.params;
  // Prix tel que le propriétaire le connaît : au sac pour l'aliment (voir
  // POIDS_SAC_KG), à l'unité du stock pour le reste.
  const { prixUnitaire } = req.body;
  // Poussins payés par le propriétaire : l'ouvrier n'a saisi ni le prix ni la
  // provenance (le couvoir), c'est donc au propriétaire de donner les deux.
  const provenance = String(req.body.provenance ?? "").trim() || null;

  const table = ORIGINES[origine];
  if (!table) {
    return res.status(400).json({ erreur: "Type de réception inconnu." });
  }
  if (prixUnitaire == null || Number.isNaN(Number(prixUnitaire)) || Number(prixUnitaire) <= 0) {
    return res.status(400).json({ erreur: "Prix unitaire invalide." });
  }
  if (origine === "poussins" && !provenance) {
    return res.status(400).json({ erreur: "Indiquez la provenance des poussins." });
  }

  // Le poulailler doit être à lui, et le prix doit encore manquer : un prix
  // déjà saisi par l'ouvrier ne se corrige pas depuis cet écran, sans quoi
  // une dépense pourrait changer après coup sans trace.
  const REQUETES = {
    produit: `UPDATE stock_receptions r
            SET prix_unitaire = $1::numeric
                  / CASE
                      WHEN sp.produit_id = 'aliment' THEN ${POIDS_SAC_KG}
                      WHEN r.doses_par_unite IS NOT NULL THEN r.doses_par_unite
                      ELSE 1
                    END
          FROM stock_produits sp, poulaillers pl, fermes f
          WHERE r.id = $2
            AND sp.id = r.stock_produit_id
            AND pl.id = sp.poulailler_id
            AND f.id = pl.ferme_id
            AND f.proprietaire_id = $3
            AND r.prix_unitaire IS NULL
          RETURNING r.id, sp.poulailler_id, sp.nom AS produit, sp.unite,
                    (sp.produit_id = 'aliment') AS en_sacs, r.doses_par_unite,
                    r.quantite_recue AS quantite, r.date_reception`,
    autre: `UPDATE stock_autres_produits r
            SET prix_unitaire = $1
          FROM poulaillers pl, fermes f
          WHERE r.id = $2
            AND pl.id = r.poulailler_id
            AND f.id = pl.ferme_id
            AND f.proprietaire_id = $3
            AND r.prix_unitaire IS NULL
          RETURNING r.id, r.poulailler_id, r.nom AS produit, 'unités' AS unite,
                    false AS en_sacs, r.quantite, r.date_reception`,
    poussins: `UPDATE bandes r
            SET prix_unitaire_poussin = $1, provenance = $4
          FROM poulaillers pl, fermes f
          WHERE r.id = $2
            AND pl.id = r.poulailler_id
            AND f.id = pl.ferme_id
            AND f.proprietaire_id = $3
            AND r.prix_unitaire_poussin IS NULL
          RETURNING r.id, r.poulailler_id, 'Poussins' AS produit, 'sujets' AS unite,
                    false AS en_sacs, r.id AS bande_id, r.provenance,
                    coalesce(r.poussins_commandes, r.poussins_recus) AS quantite,
                    r.date_debut AS date_reception`,
  };
  const condition = REQUETES[origine];
  const parametres = [Number(prixUnitaire), receptionId, req.utilisateur.id];
  if (origine === "poussins") parametres.push(provenance);

  try {
    const { rows, rowCount } = await pool.query(condition, parametres);

    if (rowCount === 0) {
      return res.status(404).json({
        erreur: "Réception introuvable, ou son prix est déjà renseigné.",
      });
    }

    const ligne = rows[0];

    parProprietaire(req, {
      action: "prix_reception_renseigne",
      cibleType: "reception",
      cibleId: Number(receptionId),
      poulaillerId: ligne.poulailler_id,
      bandeId: ligne.bande_id,
      details: (() => {
        // Le journal garde ce que le propriétaire a saisi, dans SON unité :
        // « 4 flacons de 1 000 doses à 12 000 F » se relit, « 4 000 doses à
        // 12 F » demande un calcul pour vérifier.
        const doses = ligne.doses_par_unite ? Number(ligne.doses_par_unite) : null;
        const parAchat = ligne.en_sacs ? POIDS_SAC_KG : (doses ?? 1);
        return {
        origine,
        produit: ligne.produit,
        quantite: Number(ligne.quantite) / parAchat,
        unite: ligne.en_sacs ? "sacs" : doses ? "flacons" : ligne.unite,
        prixUnitaire: Number(prixUnitaire),
        unitePrix: ligne.en_sacs
          ? `sac de ${POIDS_SAC_KG} kg`
          : doses
            ? `flacon de ${doses} doses`
            : origine === "poussins" ? "poussin" : ligne.unite,
        ...(ligne.provenance ? { provenance: ligne.provenance } : {}),
        dateReception: ligne.date_reception,
        };
      })(),
    });

    res.json({ id: Number(receptionId), origine, prixUnitaire: Number(prixUnitaire) });
  } catch (erreur) {
    console.error("Erreur prix d'une réception :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = { registreReceptions, renseignerPrix, LIBELLE_POSTE };
