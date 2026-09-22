const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");
const { normaliser, NB_CHIFFRES } = require("../utils/telephone");

const TOUR_DE_HACHAGE = 10;
const TENTATIVES_MAX = 3;

function genererToken(ouvrierId) {
  return jwt.sign({ ouvrierId }, process.env.JWT_SECRET, { expiresIn: "30d" });
}

// Le compte d'un ouvrier est créé par SEDAP depuis l'interface admin
// (POST /api/admin/poulaillers/:id/ouvrier). L'ancienne route publique
// /api/auth/pre-inscrire, qui permettait à n'importe qui d'en créer un, a
// été supprimée. L'ouvrier ne fait ici que définir son PIN sur un compte
// qui existe déjà, puis se connecter.

// Un numéro se reconnaît sur ses 9 derniers chiffres, comme chez le
// propriétaire : « 77 248 50 06 », « 772485006 », « +221772485006 » et
// « 221772485006 » désignent le même ouvrier. Jusqu'ici la comparaison se
// faisait caractère pour caractère, et un compte créé avec un « + » ne
// pouvait plus se connecter depuis un téléphone qui l'envoyait sans.
const REQUETE_PAR_TELEPHONE = `
  SELECT id, pin_hash, prenom, tentatives_echouees, compte_verrouille
    FROM ouvriers
   WHERE right(regexp_replace(telephone, '\\D', '', 'g'), ${NB_CHIFFRES}) = $1
   LIMIT 1
`;

// Moins de 9 chiffres : la comparaison n'aurait pas de sens (right('', 9)
// vaudrait '' des deux côtés). On répond « inconnu » sans interroger la base.
async function chercherOuvrier(telephone) {
  const chiffres = normaliser(telephone);
  if (chiffres.length !== NB_CHIFFRES) return null;
  const { rows } = await pool.query(REQUETE_PAR_TELEPHONE, [chiffres]);
  return rows[0] ?? null;
}

// Vérifie si un numéro est reconnu AVANT de laisser l'ouvrier taper un
// code (retour Ndeye : sans ça, on le laissait créer/confirmer un PIN
// en entier avant de lui dire "numéro non reconnu" — confus et inutile).
async function verifierTelephone(req, res) {
  try {
    const ouvrier = await chercherOuvrier(req.params.telephone);
    if (!ouvrier) {
      return res.json({ existe: false, aDejaUnPin: false });
    }

    res.json({ existe: true, aDejaUnPin: !!ouvrier.pin_hash });
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
    const ouvrier = await chercherOuvrier(telephone);

    if (!ouvrier) {
      return res.status(404).json({ erreur: "Numéro non reconnu. Demandez à votre responsable de vous enregistrer d'abord." });
    }

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

async function connexion(req, res) {
  const { telephone, pin } = req.body;

  if (!telephone || !pin) {
    return res.status(400).json({ erreur: "Téléphone et code PIN requis." });
  }

  try {
    const ouvrier = await chercherOuvrier(telephone);

    if (!ouvrier) {
      return res.status(404).json({ erreur: "Aucun compte trouvé pour ce numéro." });
    }

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

module.exports = { verifierTelephone, creerPin, connexion, moi };
