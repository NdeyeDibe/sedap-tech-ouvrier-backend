// Contrôleur "suivi" — Vaccination, Pesage et Produits utilisés (CDC
// section VI et VIII). Ces trois éléments partagent une caractéristique
// commune : ils sont STOCK-AWARE — on vérifie/décrémente le stock réel
// du poulailler avant de les accepter (cohérent avec la logique déjà
// construite côté frontend).
//
// Règle Vaccination (décision Ndeye) : confirmer un vaccin fait
// DÉCRÉMENTE le stock ET l'enregistre automatiquement comme "produit
// utilisé", sans que l'ouvrier ait à le redéclarer séparément.
const pool = require("../db/pool");
const { obtenirPoulaillerOuvrier } = require("../utils/poulailler");

// Table de référence poids/âge — CDC section VI.1 (même table que
// lib/pesageTable.js côté frontend, dupliquée ici pour calculer
// dans_fourchette côté serveur plutôt que de faire confiance au client)
const TABLE_PESAGE = [
  { jour: 0, min: 35, max: null },
  { jour: 7, min: 160, max: 220 },
  { jour: 14, min: 450, max: 600 },
  { jour: 21, min: 800, max: 1000 },
  { jour: 28, min: 1250, max: 1550 },
  { jour: 35, min: 1700, max: 2200 },
];

function getReferencePesage(jour) {
  const passees = TABLE_PESAGE.filter((r) => r.jour <= jour);
  return passees[passees.length - 1] || TABLE_PESAGE[0];
}

// POST /api/bandes/:bandeId/vaccinations
// Body : { jourBande, vaccinNom, varianteId? }
// varianteId optionnel : certaines entrées du programme (Vitamine
// seule, sans vaccin nommé) ne correspondent à aucune variante de la
// catégorie stock "vaccin" — dans ce cas, pas de vérification de stock
// (cohérent avec VaccinationForm.jsx côté frontend).
async function enregistrerVaccination(req, res) {
  const { bandeId } = req.params;
  const { jourBande, vaccinNom, varianteId } = req.body;

  if (!jourBande || !vaccinNom) {
    return res.status(400).json({ erreur: "jourBande et vaccinNom sont requis." });
  }

  const client = await pool.connect();
  try {
    const poulaillerId = await obtenirPoulaillerOuvrier(req.ouvrierId);
    await client.query("BEGIN");

    let stockProduitId = null;
    if (varianteId) {
      const resultatStock = await client.query(
        "SELECT id, quantite FROM stock_produits WHERE poulailler_id = $1 AND produit_id = 'vaccin' AND variante_id = $2",
        [poulaillerId, varianteId]
      );
      if (resultatStock.rows.length === 0) {
        throw { statut: 400, message: "Vaccin inconnu dans le stock." };
      }
      const stock = resultatStock.rows[0];
      if (stock.quantite <= 0) {
        throw { statut: 409, message: "Ce vaccin n'est pas en stock." };
      }
      stockProduitId = stock.id;

      await client.query("UPDATE stock_produits SET quantite = quantite - 1 WHERE id = $1", [stockProduitId]);
    }

    const resultatVaccination = await client.query(
      `INSERT INTO vaccinations (bande_id, jour_bande, vaccin_nom, date_saisie)
       VALUES ($1, $2, $3, CURRENT_DATE) RETURNING *`,
      [bandeId, jourBande, vaccinNom]
    );

    // Enregistré automatiquement comme "produit utilisé" — l'ouvrier
    // n'a pas à le redéclarer dans l'écran "Produits utilisés"
    // (décision Ndeye)
    if (stockProduitId) {
      await client.query(
        `INSERT INTO produits_utilises (bande_id, stock_produit_id, quantite, date_saisie)
         VALUES ($1, $2, 1, CURRENT_DATE)`,
        [bandeId, stockProduitId]
      );
    }

    await client.query("COMMIT");
    res.status(201).json(resultatVaccination.rows[0]);
  } catch (erreur) {
    await client.query("ROLLBACK");
    if (erreur.statut) {
      return res.status(erreur.statut).json({ erreur: erreur.message });
    }
    console.error("Erreur enregistrement vaccination :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

// POST /api/bandes/:bandeId/pesages
// Body : { jourBande, poidsG }
// Ne consomme aucun stock — juste comparé à la table de référence.
// Note CDC : hors fourchette n'empêche PAS l'enregistrement (juste une
// alerte visuelle côté frontend).
async function enregistrerPesage(req, res) {
  const { bandeId } = req.params;
  const { jourBande, poidsG } = req.body;

  if (!jourBande || !poidsG || poidsG <= 0) {
    return res.status(400).json({ erreur: "jourBande et poidsG (positif) sont requis." });
  }

  try {
    const reference = getReferencePesage(jourBande);
    const dansFourchette = poidsG >= reference.min && (reference.max === null || poidsG <= reference.max);

    const resultat = await pool.query(
      `INSERT INTO pesages (bande_id, jour_bande, poids_g, dans_fourchette, date_saisie)
       VALUES ($1, $2, $3, $4, CURRENT_DATE) RETURNING *`,
      [bandeId, jourBande, poidsG, dansFourchette]
    );

    res.status(201).json(resultat.rows[0]);
  } catch (erreur) {
    console.error("Erreur enregistrement pesage :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// POST /api/bandes/:bandeId/produits-utilises
// Body : { lignes: [{ produitId, varianteId, quantite }] } — Gaz,
// Litière, Vitamines, Antistress, Vaccin (déclaration manuelle, écran
// "Produits utilisés"). Décrémente le stock pour chaque ligne.
async function enregistrerProduitsUtilises(req, res) {
  const { bandeId } = req.params;
  const { lignes } = req.body;

  if (!Array.isArray(lignes) || lignes.length === 0) {
    return res.status(400).json({ erreur: "Au moins une ligne est requise." });
  }

  const client = await pool.connect();
  try {
    const poulaillerId = await obtenirPoulaillerOuvrier(req.ouvrierId);
    await client.query("BEGIN");

    const lignesTraitees = [];
    for (const ligne of lignes) {
      // Retour Ndeye : la catégorie "Autre" (nom libre, table à part
      // stock_autres_produits) était jusqu'ici impossible à déclarer ici
      // — chaque ligne précise maintenant explicitement de laquelle des
      // deux tables il s'agit.
      if (ligne.estAutre) {
        const resultatStock = await client.query(
          "SELECT id, quantite FROM stock_autres_produits WHERE id = $1 AND poulailler_id = $2",
          [ligne.autreProduitId, poulaillerId]
        );
        if (resultatStock.rows.length === 0) {
          throw { statut: 400, message: `Produit "Autre" introuvable (id ${ligne.autreProduitId}).` };
        }
        const stock = resultatStock.rows[0];
        if (stock.quantite < ligne.quantite) {
          throw { statut: 409, message: `Stock insuffisant (${stock.quantite} disponible).` };
        }

        await client.query("UPDATE stock_autres_produits SET quantite = quantite - $1 WHERE id = $2", [ligne.quantite, stock.id]);

        const resultatLigne = await client.query(
          `INSERT INTO produits_utilises (bande_id, stock_autre_produit_id, quantite, date_saisie)
           VALUES ($1, $2, $3, CURRENT_DATE) RETURNING *`,
          [bandeId, stock.id, ligne.quantite]
        );
        lignesTraitees.push(resultatLigne.rows[0]);
        continue;
      }

      const resultatStock = await client.query(
        "SELECT id, quantite FROM stock_produits WHERE poulailler_id = $1 AND produit_id = $2 AND variante_id = $3",
        [poulaillerId, ligne.produitId, ligne.varianteId]
      );
      if (resultatStock.rows.length === 0) {
        throw { statut: 400, message: `Produit inconnu : ${ligne.produitId}.${ligne.varianteId}` };
      }
      const stock = resultatStock.rows[0];
      if (stock.quantite < ligne.quantite) {
        throw { statut: 409, message: `Stock insuffisant pour ${ligne.produitId}.${ligne.varianteId} (${stock.quantite} disponible).` };
      }

      await client.query("UPDATE stock_produits SET quantite = quantite - $1 WHERE id = $2", [ligne.quantite, stock.id]);

      const resultatLigne = await client.query(
        `INSERT INTO produits_utilises (bande_id, stock_produit_id, quantite, date_saisie)
         VALUES ($1, $2, $3, CURRENT_DATE) RETURNING *`,
        [bandeId, stock.id, ligne.quantite]
      );
      lignesTraitees.push(resultatLigne.rows[0]);
    }

    await client.query("COMMIT");
    res.status(201).json(lignesTraitees);
  } catch (erreur) {
    await client.query("ROLLBACK");
    if (erreur.statut) {
      return res.status(erreur.statut).json({ erreur: erreur.message });
    }
    console.error("Erreur enregistrement produits utilisés :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

module.exports = { enregistrerVaccination, enregistrerPesage, enregistrerProduitsUtilises };
