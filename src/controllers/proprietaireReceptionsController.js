const pool = require("../db/pool");

// Réceptions de stock vues par le propriétaire.
//
// L'ouvrier déclare chaque réception en indiquant qui l'a payée. Quand c'est
// le propriétaire qui a commandé et réglé chez le fournisseur, l'ouvrier ne
// saisit que la quantité reçue : le prix manque, et c'est au propriétaire de
// le compléter ici — comme il chiffre les sujets partis en ramassage.
//
// Le rattachement d'une réception à une bande se fait par date (vue
// receptions_ferme), jamais recalculé ici.

const ORIGINES = { produit: "stock_receptions", autre: "stock_autres_produits" };

const LIBELLE_POSTE = {
  aliment: "Aliment",
  gaz: "Gaz",
  litiere: "Litière",
  vitamines: "Vitamines",
  antistress: "Antistress",
  vaccin: "Médicaments & vaccins",
  autres: "Autres produits",
};

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
  const prix = ligne.prix_unitaire === null ? null : Number(ligne.prix_unitaire);

  return {
    origine: ligne.origine,
    id: ligne.id,
    poste: ligne.poste,
    libelle: LIBELLE_POSTE[ligne.poste] ?? ligne.poste,
    nom: ligne.nom,
    unite: ligne.unite,
    quantite: Number(ligne.quantite),
    prixUnitaire: prix,
    montant: prix === null ? null : Number(ligne.quantite) * prix,
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
      `SELECT r.*, b.numero AS bande_numero
         FROM receptions_ferme r
         LEFT JOIN bandes b ON b.id = r.bande_id
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
  const { prixUnitaire } = req.body;

  const table = ORIGINES[origine];
  if (!table) {
    return res.status(400).json({ erreur: "Type de réception inconnu." });
  }
  if (prixUnitaire == null || Number.isNaN(Number(prixUnitaire)) || Number(prixUnitaire) < 0) {
    return res.status(400).json({ erreur: "Prix unitaire invalide." });
  }

  // Le poulailler doit être à lui, et le prix doit encore manquer : un prix
  // déjà saisi par l'ouvrier ne se corrige pas depuis cet écran, sans quoi
  // une dépense pourrait changer après coup sans trace.
  const condition =
    origine === "produit"
      ? `UPDATE stock_receptions r
            SET prix_unitaire = $1
          FROM stock_produits sp, poulaillers pl, fermes f
          WHERE r.id = $2
            AND sp.id = r.stock_produit_id
            AND pl.id = sp.poulailler_id
            AND f.id = pl.ferme_id
            AND f.proprietaire_id = $3
            AND r.prix_unitaire IS NULL
          RETURNING r.id`
      : `UPDATE stock_autres_produits r
            SET prix_unitaire = $1
          FROM poulaillers pl, fermes f
          WHERE r.id = $2
            AND pl.id = r.poulailler_id
            AND f.id = pl.ferme_id
            AND f.proprietaire_id = $3
            AND r.prix_unitaire IS NULL
          RETURNING r.id`;

  try {
    const { rowCount } = await pool.query(condition, [
      Number(prixUnitaire),
      receptionId,
      req.utilisateur.id,
    ]);

    if (rowCount === 0) {
      return res.status(404).json({
        erreur: "Réception introuvable, ou son prix est déjà renseigné.",
      });
    }

    res.json({ id: Number(receptionId), origine, prixUnitaire: Number(prixUnitaire) });
  } catch (erreur) {
    console.error("Erreur prix d'une réception :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = { registreReceptions, renseignerPrix, LIBELLE_POSTE };
