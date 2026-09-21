// Catalogue de stock d'un poulailler neuf — reproduit lib/stockMock.js du
// front ouvrier, pour que les deux restent cohérents.
//
// Vivait dans authController.js, parce que c'était la pré-inscription qui
// créait le poulailler. C'est désormais l'admin qui le fait : le catalogue
// sort donc du contrôleur d'authentification.
//
// Toutes les quantités démarrent à 0 : c'est la réception (Stock → Recevoir)
// qui les remplit.
const CATALOGUE_STOCK_INITIAL = [
  { produitId: "aliment", varianteId: "demarrage", nom: "Démarrage", unite: "kg" },
  { produitId: "aliment", varianteId: "croissance", nom: "Croissance", unite: "kg" },
  { produitId: "aliment", varianteId: "finition", nom: "Finition", unite: "kg" },
  { produitId: "gaz", varianteId: "6kg", nom: "Bouteille 6 kg", unite: "bouteilles" },
  { produitId: "gaz", varianteId: "9kg", nom: "Bouteille 9 kg", unite: "bouteilles" },
  { produitId: "litiere", varianteId: "balle_riz", nom: "Balle de riz", unite: "sacs" },
  { produitId: "litiere", varianteId: "copeaux", nom: "Copeaux de bois", unite: "sacs" },
  { produitId: "litiere", varianteId: "coque_arachide", nom: "Coque d'arachide", unite: "sacs" },
  { produitId: "vitamines", varianteId: "pot", nom: "Pot 1 kg", unite: "unités" },
  { produitId: "vitamines", varianteId: "sachet", nom: "Sachet 100 g", unite: "unités" },
  { produitId: "antistress", varianteId: "pot", nom: "Pot 1 kg", unite: "unités" },
  { produitId: "antistress", varianteId: "sachet", nom: "Sachet 100 g", unite: "unités" },
  { produitId: "vaccin", varianteId: "gumboro_l", nom: "Gumboro L", unite: "doses" },
  { produitId: "vaccin", varianteId: "h120", nom: "H120", unite: "doses" },
  { produitId: "vaccin", varianteId: "gumboro_ibdl", nom: "Gumboro IBDL", unite: "doses" },
  { produitId: "vaccin", varianteId: "lasota", nom: "Lasota", unite: "doses" },
];

// Crée les lignes manquantes seulement : rejouable sans risque sur un
// poulailler qui a déjà son stock (la contrainte UNIQUE de stock_produits
// écarte les doublons, et aucune quantité existante n'est touchée).
async function creerStockInitial(client, poulaillerId) {
  for (const p of CATALOGUE_STOCK_INITIAL) {
    await client.query(
      `INSERT INTO stock_produits (poulailler_id, produit_id, variante_id, nom, unite, quantite)
       VALUES ($1, $2, $3, $4, $5, 0)
       ON CONFLICT (poulailler_id, produit_id, variante_id) DO NOTHING`,
      [poulaillerId, p.produitId, p.varianteId, p.nom, p.unite]
    );
  }
}

module.exports = { CATALOGUE_STOCK_INITIAL, creerStockInitial };
