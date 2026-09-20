// Contrôleur Stock — CDC section VIII. Gère le catalogue de produits
// (déjà initialisé à l'inscription, voir authController.js ->
// seedStockInitial) et les réceptions de stock.
const pool = require("../db/pool");
const { obtenirPoulaillerOuvrier } = require("../utils/poulailler");

// GET /api/stock — liste de tous les produits/variantes en stock pour
// le poulailler de l'ouvrier connecté
async function listerStock(req, res) {
  try {
    const poulaillerId = await obtenirPoulaillerOuvrier(req.ouvrierId);
    if (!poulaillerId) {
      return res.status(404).json({ erreur: "Aucun poulailler associé à ce compte." });
    }

    const resultat = await pool.query(
      `SELECT id, produit_id, variante_id, nom, unite, quantite
       FROM stock_produits
       WHERE poulailler_id = $1
       ORDER BY produit_id, variante_id`,
      [poulaillerId]
    );

    res.json(resultat.rows);
  } catch (erreur) {
    console.error("Erreur liste stock :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// POST /api/stock/:produitId/reception — enregistre une réception pour
// une ou plusieurs variantes d'une catégorie (CDC VIII.2)
// Body : { provenance?, source?, lignes: [{ varianteId, quantiteRecue, prixUnitaire }] }
// source = "ouvrier" (défaut, prix obligatoire) ou "proprietaire" — le
// propriétaire a déjà commandé et payé lui-même : l'ouvrier ne renseigne
// que la quantité reçue, prix laissé NULL jusqu'à ce que le propriétaire
// le complète depuis son interface (retour Ndeye, sept. 2026).
async function recevoirStock(req, res) {
  const { produitId } = req.params;
  const { provenance, lignes } = req.body;
  const source = req.body.source === "proprietaire" ? "proprietaire" : "ouvrier";

  if (!Array.isArray(lignes) || lignes.length === 0) {
    return res.status(400).json({ erreur: "Au moins une ligne de réception est requise." });
  }
  for (const ligne of lignes) {
    if (!ligne.varianteId || !ligne.quantiteRecue || ligne.quantiteRecue <= 0) {
      return res.status(400).json({ erreur: "Chaque ligne doit avoir une variante et une quantité valides." });
    }
    if (source === "ouvrier" && (!ligne.prixUnitaire || ligne.prixUnitaire <= 0)) {
      return res.status(400).json({ erreur: "Chaque ligne doit avoir un prix unitaire valide." });
    }
  }

  const client = await pool.connect();
  try {
    const poulaillerId = await obtenirPoulaillerOuvrier(req.ouvrierId);
    if (!poulaillerId) {
      return res.status(404).json({ erreur: "Aucun poulailler associé à ce compte." });
    }

    await client.query("BEGIN");

    const lignesTraitees = [];
    for (const ligne of lignes) {
      const resultatProduit = await client.query(
        "SELECT id FROM stock_produits WHERE poulailler_id = $1 AND produit_id = $2 AND variante_id = $3",
        [poulaillerId, produitId, ligne.varianteId]
      );
      if (resultatProduit.rows.length === 0) {
        throw new Error(`Produit inconnu : ${produitId}.${ligne.varianteId}`);
      }
      const stockProduitId = resultatProduit.rows[0].id;

      await client.query(
        "UPDATE stock_produits SET quantite = quantite + $1 WHERE id = $2",
        [ligne.quantiteRecue, stockProduitId]
      );

      const resultatReception = await client.query(
        `INSERT INTO stock_receptions (stock_produit_id, quantite_recue, prix_unitaire, provenance, source)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          stockProduitId,
          ligne.quantiteRecue,
          source === "proprietaire" ? null : ligne.prixUnitaire,
          provenance || null,
          source,
        ]
      );
      lignesTraitees.push(resultatReception.rows[0]);
    }

    await client.query("COMMIT");
    res.status(201).json(lignesTraitees);
  } catch (erreur) {
    await client.query("ROLLBACK");
    console.error("Erreur réception stock :", erreur);
    res.status(500).json({ erreur: erreur.message || "Erreur serveur." });
  } finally {
    client.release();
  }
}

// GET /api/stock/autres — liste des "autres produits" (nom libre, CDC VIII.2)
async function listerAutresProduits(req, res) {
  try {
    const poulaillerId = await obtenirPoulaillerOuvrier(req.ouvrierId);
    const resultat = await pool.query(
      "SELECT * FROM stock_autres_produits WHERE poulailler_id = $1 ORDER BY date_reception DESC",
      [poulaillerId]
    );
    res.json(resultat.rows);
  } catch (erreur) {
    console.error("Erreur liste autres produits :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// POST /api/stock/autres — ajouter un "autre produit" (nom libre)
// Body : { nom, quantite, prixUnitaire?, source? } — voir recevoirStock
// ci-dessus pour la règle "source" (ouvrier paie / propriétaire a déjà payé).
async function ajouterAutreProduit(req, res) {
  const { nom, quantite } = req.body;
  const source = req.body.source === "proprietaire" ? "proprietaire" : "ouvrier";
  const prixUnitaire = req.body.prixUnitaire;

  if (!nom || !quantite || quantite <= 0) {
    return res.status(400).json({ erreur: "Nom et quantité valides sont requis." });
  }
  if (source === "ouvrier" && (!prixUnitaire || prixUnitaire <= 0)) {
    return res.status(400).json({ erreur: "Prix unitaire valide requis." });
  }

  try {
    const poulaillerId = await obtenirPoulaillerOuvrier(req.ouvrierId);
    if (!poulaillerId) {
      return res.status(404).json({ erreur: "Aucun poulailler associé à ce compte." });
    }

    const resultat = await pool.query(
      `INSERT INTO stock_autres_produits (poulailler_id, nom, quantite, prix_unitaire, source)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [poulaillerId, nom.trim(), quantite, source === "proprietaire" ? null : prixUnitaire, source]
    );
    res.status(201).json(resultat.rows[0]);
  } catch (erreur) {
    console.error("Erreur ajout autre produit :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = { listerStock, recevoirStock, listerAutresProduits, ajouterAutreProduit };
