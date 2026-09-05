const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");

const TOUR_DE_HACHAGE = 10;
const TENTATIVES_MAX = 3;

function genererToken(ouvrierId) {
  return jwt.sign({ ouvrierId }, process.env.JWT_SECRET, { expiresIn: "30d" });
}

// PRÉ-INSCRIPTION — TODO(INTERFACE PROPRIÉTAIRE) : cet endpoint tient
// lieu de l'interface propriétaire, qui n'existe pas encore dans ce
// projet. C'est LUI qui doit créer le compte de l'ouvrier (nom, prénom,
// téléphone) avant que celui-ci ne reçoive le lien de l'appli par SMS.
// Pas de PIN ici : l'ouvrier le définit lui-même à sa première
// connexion (voir creerPin ci-dessous). Volontairement SANS
// authentification pour l'instant (aucun rôle "propriétaire" n'existe
// encore) — à sécuriser dès que l'interface propriétaire sera bâtie.
async function preInscrire(req, res) {
  const { telephone, nom, prenom } = req.body;

  if (!telephone) {
    return res.status(400).json({ erreur: "Téléphone requis." });
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

    await client.query("BEGIN");

    const resultatOuvrier = await client.query(
      `INSERT INTO ouvriers (telephone, nom, prenom)
       VALUES ($1, $2, $3) RETURNING id`,
      [telephone, nom || null, prenom || null]
    );
    const ouvrierId = resultatOuvrier.rows[0].id;

    const resultatPoulailler = await client.query(
      "INSERT INTO poulaillers (ouvrier_id) VALUES ($1) RETURNING id",
      [ouvrierId]
    );
    const poulaillerId = resultatPoulailler.rows[0].id;

    await seedStockInitial(client, poulaillerId);

    await client.query("COMMIT");
    res.status(201).json({ ouvrierId, telephone });
  } catch (erreur) {
    await client.query("ROLLBACK");
    console.error("Erreur pré-inscription :", erreur);
    res.status(500).json({ erreur: "Erreur serveur pendant la pré-inscription." });
  } finally {
    client.release();
  }
}

// L'ouvrier définit son code PIN sur un compte DÉJÀ pré-enregistré par
// le propriétaire (voir preInscrire ci-dessus) — ne crée jamais de
// nouveau compte lui-même.
// Vérifie si un numéro est reconnu AVANT de laisser l'ouvrier taper un
// code (retour Ndeye : sans ça, on le laissait créer/confirmer un PIN
// en entier avant de lui dire "numéro non reconnu" — confus et inutile).
async function verifierTelephone(req, res) {
  const { telephone } = req.params;
  try {
    const resultat = await pool.query(
      "SELECT pin_hash FROM ouvriers WHERE telephone = $1",
      [telephone]
    );
    if (resultat.rows.length === 0) {
      return res.json({ existe: false, aDejaUnPin: false });
    }
    res.json({ existe: true, aDejaUnPin: !!resultat.rows[0].pin_hash });
  } catch (erreur) {
    console.error("Erreur vérification téléphone :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

async function creerPin(req, res) {
  const { telephone, pin } = req.body;

  if (!telephone || !pin) {
    return res.status(400).json({ erreur: "Téléphone et code PIN requis." });
  }
  if (!/^\d{4}$/.test(pin)) {
    return res.status(400).json({ erreur: "Le code PIN doit contenir exactement 4 chiffres." });
  }

  try {
    const resultat = await pool.query(
      "SELECT id, pin_hash, prenom FROM ouvriers WHERE telephone = $1",
      [telephone]
    );

    if (resultat.rows.length === 0) {
      return res.status(404).json({ erreur: "Numéro non reconnu. Demandez à votre responsable de vous enregistrer d'abord." });
    }

    const ouvrier = resultat.rows[0];

    if (ouvrier.pin_hash) {
      return res.status(409).json({ erreur: "Ce compte a déjà un code PIN. Utilisez plutôt la connexion." });
    }

    const pinHash = await bcrypt.hash(pin, TOUR_DE_HACHAGE);
    await pool.query("UPDATE ouvriers SET pin_hash = $1 WHERE id = $2", [pinHash, ouvrier.id]);

    const token = genererToken(ouvrier.id);
    res.status(201).json({ token, ouvrierId: ouvrier.id, prenom: ouvrier.prenom });
  } catch (erreur) {
    console.error("Erreur création PIN :", erreur);
    res.status(500).json({ erreur: "Erreur serveur pendant la création du code." });
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

    if (!ouvrier.pin_hash) {
      return res.status(409).json({ erreur: "Aucun code PIN défini pour ce compte. Créez-le d'abord." });
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
      "SELECT id, telephone, nom, prenom FROM ouvriers WHERE id = $1",
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

module.exports = { preInscrire, verifierTelephone, creerPin, connexion, moi };