// Mise en forme, pour le propriétaire, de ce que SEDAP a corrigé sur une
// bande.
//
// Le propriétaire doit voir toutes les corrections, pas seulement celles
// portant sur les chiffres de la bande : une vente corrigée touche
// directement son argent, une mortalité corrigée change son taux. Une
// correction qu'il découvre plus tard sans explication, c'est la confiance
// dans l'appli qui tombe.
//
// Les entrées viennent du journal d'activité, qui est en écriture seule :
// elles ne peuvent être ni modifiées ni effacées.

// Les actions que le propriétaire voit. Le journal en contient d'autres
// (ses propres actions, la création de comptes) qui n'ont rien à faire ici.
const ACTIONS_VISIBLES = [
  "bande_corrigee",
  "saisie_corrigee",
  "vente_corrigee",
  "vente_supprimee_admin",
  "reception_corrigee",
];

function jourCourt(valeur) {
  if (!valeur) return null;
  const d = new Date(valeur);
  if (Number.isNaN(d.getTime())) return null;
  const deux = (n) => String(n).padStart(2, "0");
  return `${deux(d.getDate())}/${deux(d.getMonth() + 1)}`;
}

// Sur quoi porte la correction, en une poignée de mots.
function surQuoi(ligne) {
  switch (ligne.action) {
    case "saisie_corrigee": {
      const jour = jourCourt(ligne.details?.date);
      return jour ? `Saisie du ${jour}` : "Saisie du jour";
    }
    case "vente_corrigee":
      return "Vente";
    case "vente_supprimee_admin":
      return "Vente supprimée";
    case "reception_corrigee":
      return ligne.details?.produit ? `Réception · ${ligne.details.produit}` : "Réception de stock";
    default:
      return "Chiffres de la bande";
  }
}

/**
 * Une entrée du journal en quelque chose d'affichable.
 *
 * @returns { date, quoi, motif, champs: [{ libelle, avant, apres }] }
 */
function correctionLisible(ligne) {
  const details = ligne.details ?? {};

  // Une vente supprimée n'a pas de « avant / après » : la ligne entière a
  // disparu. On la présente comme telle, sinon le propriétaire verrait une
  // correction vide et ne saurait pas ce qui s'est passé.
  if (ligne.action === "vente_supprimee_admin") {
    const v = details.vente ?? {};
    const quoi = [
      v.quantite != null ? `${v.quantite} sujets` : null,
      v.client || null,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      date: ligne.cree_le,
      quoi: surQuoi(ligne),
      motif: details.motif ?? null,
      champs: [{ libelle: "Vente retirée", avant: quoi || "vente", apres: null }],
    };
  }

  return {
    date: ligne.cree_le,
    quoi: surQuoi(ligne),
    motif: details.motif ?? null,
    champs: Object.entries(details.champs ?? {}).map(([colonne, v]) => ({
      libelle: v.libelle ?? colonne,
      avant: v.avant,
      apres: v.apres,
    })),
  };
}

module.exports = { ACTIONS_VISIBLES, correctionLisible };
