const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");

const TOUR_DE_HACHAGE = 10;
const TENTATIVES_MAX = 3;

function genererToken(ouvrierId) {
  return jwt.sign({ ouvrierId }, process.env.JWT_SECRET, { expiresIn: "30d" });
}

async function inscription(req, res) {
  const { telephone, pin, prenom } = req.body;

  if (!telephone || !pin) {
    return res.status(400).json({ erreur: "Téléphone et code PIN requis." });
  }
  if (!/^\d{4}$/.test(pin)) {
    return res.status(400).json({ erreur: "Le code PIN doit contenir exactement 4 chiffres." });
  }

  const client = await pool.connect();
  try {
    const dejaExistant = await client.query(
      "SELECT id FROM ouvriers WHERE telephone = $1",
      [telephone]
    );
    if (dejaExistant.rows.length > 0) {
      return res.status(409).json({ erreur: "Ce numéro de téléphone a déjà un compte." });
    }

    const pinHash = await bcrypt.hash(pin, TOUR_DE_HACHAGE);

    await client.query("BEGIN");

    const resultatOuvrier = await client.query(
      `INSERT INTO ouvriers (telephone, pin_hash, prenom)
       VALUES ($1, $2, $3) RETURNING id, prenom`,
      [telephone, pinHash, prenom || null]
    );
    const ouvrier = resultatOuvrier.rows[0];

    const resultatPoulailler = await client.query(
      "INSERT INTO poulaillers (ouvrier_id) VALUES ($1) RETURNING id",
      [ouvrier.id]
    );
    const poulaillerId = resultatPoulailler.rows[0].id;

    // Initialise le catalogue de stock à 0 pour ce nouveau poulailler
    // (voir stockController.js -> seedStockInitial, appelé ici pour que
    // les écrans Stock ne partent jamais de zéro catalogue vide)
    await seedStockInitial(client, poulaillerId);

    await client.query("COMMIT");

    const token = genererToken(ouvrier.id);
    res.status(201).json({ token, ouvrierId: ouvrier.id, prenom: ouvrier.prenom });
  } catch (erreur) {
    await client.query("ROLLBACK");
    console.error("Erreur inscription :", erreur);
    res.status(500).json({ erreur: "Erreur serveur pendant l'inscription." });
  } finally {
    client.release();
  }
}

// Catalogue de produits/variantes initial — reproduit fidèlement
// lib/stockMock.js du frontend, pour que les deux restent cohérents.
// Toutes les quantités démarrent à 0 (un nouveau poulailler n'a encore
// rien reçu) — c'est la réception (Stock > Recevoir) qui les remplit.
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

async function seedStockInitial(client, poulaillerId) {
  for (const p of CATALOGUE_STOCK_INITIAL) {
    await client.query(
      `INSERT INTO stock_produits (poulailler_id, produit_id, variante_id, nom, unite, quantite)
       VALUES ($1, $2, $3, $4, $5, 0)`,
      [poulaillerId, p.produitId, p.varianteId, p.nom, p.unite]
    );
  }
}

async function connexion(req, res) {
  const { telephone, pin } = req.body;

  if (!telephone || !pin) {
    return res.status(400).json({ erreur: "Téléphone et code PIN requis." });
  }

  try {
    const resultat = await pool.query(
      "SELECT id, pin_hash, prenom, tentatives_echouees, compte_verrouille FROM ouvriers WHERE telephone = $1",
      [telephone]
    );

    if (resultat.rows.length === 0) {
      return res.status(404).json({ erreur: "Aucun compte trouvé pour ce numéro." });
    }

    const ouvrier = resultat.rows[0];

    if (ouvrier.compte_verrouille) {
      return res.status(403).json({
        erreur: "Compte verrouillé. Contactez le support SEDAP pour le débloquer.",
        compteVerrouille: true,
      });
    }

    const pinCorrect = await bcrypt.compare(pin, ouvrier.pin_hash);

    if (!pinCorrect) {
      const nouvellesTentatives = ouvrier.tentatives_echouees + 1;
      const doitVerrouiller = nouvellesTentatives >= TENTATIVES_MAX;

      await pool.query(
        "UPDATE ouvriers SET tentatives_echouees = $1, compte_verrouille = $2 WHERE id = $3",
        [nouvellesTentatives, doitVerrouiller, ouvrier.id]
      );

      if (doitVerrouiller) {
        return res.status(403).json({
          erreur: "Compte verrouillé après 3 tentatives. Contactez le support SEDAP.",
          compteVerrouille: true,
        });
      }

      return res.status(401).json({
        erreur: "Code incorrect.",
        tentativesRestantes: TENTATIVES_MAX - nouvellesTentatives,
      });
    }

    await pool.query(
      "UPDATE ouvriers SET tentatives_echouees = 0 WHERE id = $1",
      [ouvrier.id]
    );

    const token = genererToken(ouvrier.id);
    res.json({ token, ouvrierId: ouvrier.id, prenom: ouvrier.prenom });
  } catch (erreur) {
    console.error("Erreur connexion :", erreur);
    res.status(500).json({ erreur: "Erreur serveur pendant la connexion." });
  }
}

async function moi(req, res) {
  try {
    const resultat = await pool.query(
      "SELECT id, telephone, prenom FROM ouvriers WHERE id = $1",
      [req.ouvrierId]
    );
    if (resultat.rows.length === 0) {
      return res.status(404).json({ erreur: "Ouvrier introuvable." });
    }
    res.json(resultat.rows[0]);
  } catch (erreur) {
    console.error("Erreur /moi :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = { inscription, connexion, moi };