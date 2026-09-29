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
// Un vaccin s'achète en flacons et se consomme en doses : le stock est
// tenu en doses, la réception compte des flacons. Sans conversion, quatre
// flacons de 1 000 doses donnaient « 4 » en stock, et plus aucune
// vaccination n'était possible (retour Ndeye, sept. 2026).
//
// Les autres produits n'ont pas de contenance : un sac est un sac. Leur
// facteur vaut 1 et rien ne change pour eux.
const PRODUITS_DOSES = ["vaccin"];
const DOSES_ADMISES = [500, 1000];

async function recevoirStock(req, res) {
  const { produitId } = req.params;
  const { provenance, lignes } = req.body;
  const source = req.body.source === "proprietaire" ? "proprietaire" : "ouvrier";
  const produitDose = PRODUITS_DOSES.includes(produitId);

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
    if (produitDose) {
      const doses = Number(ligne.dosesParUnite);
      // On refuse plutôt que de supposer : enregistrer 4 au lieu de 4 000
      // ne se voit qu'au moment de vacciner, quand il est trop tard.
      if (!DOSES_ADMISES.includes(doses)) {
        return res.status(400).json({
          erreur: "Indiquez la contenance des flacons : 500 ou 1 000 doses.",
        });
      }
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

      // Ce que la personne a compté (4 flacons) et ce que ça fait dans
      // l'unité du stock (4 000 doses).
      const unites = Number(ligne.quantiteRecue);
      const parUnite = produitDose ? Number(ligne.dosesParUnite) : 1;
      const quantiteStock = unites * parUnite;

      // Le prix saisi est celui d'un flacon ; la table le veut par unité
      // de stock, puisque la vue des dépenses calcule quantité × prix.
      const prixParUnite =
        source === "proprietaire" ? null : Number(ligne.prixUnitaire) / parUnite;

      await client.query(
        "UPDATE stock_produits SET quantite = quantite + $1 WHERE id = $2",
        [quantiteStock, stockProduitId]
      );

      const resultatReception = await client.query(
        `INSERT INTO stock_receptions
           (stock_produit_id, quantite_recue, prix_unitaire, provenance, source,
            unites_recues, doses_par_unite)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          stockProduitId,
          quantiteStock,
          prixParUnite,
          provenance || null,
          source,
          unites,
          produitDose ? parUnite : null,
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
