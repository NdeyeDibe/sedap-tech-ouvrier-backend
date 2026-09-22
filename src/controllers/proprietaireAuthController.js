const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");
const { journaliser } = require("../services/journal");

const TOUR_DE_HACHAGE = 10;
const TENTATIVES_MAX = 3;

function genererToken(proprietaireId) {
  return jwt.sign(
    { id: proprietaireId, role: "proprietaire" },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
}

// Le propriétaire ne s'inscrit jamais : SEDAP crée son compte et lui envoie
// un lien par mail ET WhatsApp. Ce lien est le secret — il ne parvient qu'aux
// coordonnées enregistrées. Il redonne ensuite l'une des deux pour confirmer
// que c'est bien lui, puis choisit son PIN.
//
// Pas de code SMS supplémentaire : c'est précisément ce qui ne passe pas
// quand le propriétaire est à l'étranger avec une carte SIM locale, et c'est
// la raison pour laquelle SEDAP crée les comptes depuis le Sénégal.

// Retrouve un compte par téléphone OU par e-mail. Le propriétaire peut avoir
// ouvert le lien depuis WhatsApp sur son téléphone ou depuis sa boîte mail sur
// un ordinateur : lui imposer le canal d'arrivée serait lui demander de se
// souvenir par où c'est passé.
//
// Le téléphone est comparé sur ses 9 derniers chiffres, pour que
// "77 000 00 00", "770000000" et "+221770000000" désignent le même compte.
const REQUETE_PAR_IDENTIFIANT = `
  SELECT id, telephone, email, nom, prenom, pin_hash,
         tentatives_echouees, compte_verrouille,
         jeton_activation, jeton_expire_le, activee_le
  FROM proprietaires
  WHERE lower(email) = lower($1)
     OR right(regexp_replace(telephone, '\\D', '', 'g'), 9)
        = right(regexp_replace($1, '\\D', '', 'g'), 9)
  LIMIT 1
`;

async function chercherParIdentifiant(identifiant) {
  const chiffres = identifiant.replace(/\D/g, "");

  // Sans au moins 9 chiffres ni arobase, la comparaison n'a pas de sens :
  // right('', 9) vaudrait '' des deux côtés et ferait correspondre n'importe qui.
  if (!identifiant.includes("@") && chiffres.length < 9) return null;

  const resultat = await pool.query(REQUETE_PAR_IDENTIFIANT, [identifiant.trim()]);
  return resultat.rows[0] ?? null;
}

function jetonValide(proprietaire, jeton) {
  if (!jeton || !proprietaire.jeton_activation) return false;
  if (proprietaire.jeton_activation !== jeton) return false;
  if (proprietaire.jeton_expire_le && new Date(proprietaire.jeton_expire_le) < new Date()) {
    return false;
  }
  return true;
}

// Dit à l'écran d'identification s'il doit envoyer vers la création du PIN
// ou vers la connexion — avant de faire saisir quoi que ce soit d'autre.
async function verifierIdentite(req, res) {
  const { identifiant } = req.body;

  if (!identifiant) {
    return res.status(400).json({ erreur: "Numéro de téléphone ou e-mail requis." });
  }

  try {
    const proprietaire = await chercherParIdentifiant(identifiant);

    if (!proprietaire) {
      return res.json({ existe: false, aDejaUnPin: false });
    }

    res.json({
      existe: true,
      aDejaUnPin: !!proprietaire.pin_hash,
      prenom: proprietaire.prenom,
    });
  } catch (erreur) {
    console.error("Erreur vérification identité propriétaire :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// Active le compte : vérifie le jeton du lien, enregistre le PIN, et consomme
// le jeton pour qu'il ne serve pas deux fois.
async function creerPin(req, res) {
  const { identifiant, pin, jeton } = req.body;

  if (!identifiant || !pin) {
    return res.status(400).json({ erreur: "Identifiant et code PIN requis." });
  }
  if (!/^\d{4}$/.test(pin)) {
    return res.status(400).json({ erreur: "Le code PIN doit contenir exactement 4 chiffres." });
  }

  try {
    const proprietaire = await chercherParIdentifiant(identifiant);

    if (!proprietaire) {
      return res.status(404).json({
        erreur: "Ces coordonnées ne correspondent à aucun compte. Contactez SEDAP.",
      });
    }

    if (proprietaire.pin_hash) {
      return res.status(409).json({
        erreur: "Ce compte a déjà un code PIN. Utilisez la connexion.",
      });
    }

    if (!jetonValide(proprietaire, jeton)) {
      return res.status(403).json({
        erreur: "Lien d'activation invalide ou expiré. Demandez-en un nouveau à SEDAP.",
      });
    }

    const pinHash = await bcrypt.hash(pin, TOUR_DE_HACHAGE);

    await pool.query(
      `UPDATE proprietaires
          SET pin_hash = $1,
              activee_le = now(),
              jeton_activation = NULL,
              jeton_expire_le = NULL
        WHERE id = $2`,
      [pinHash, proprietaire.id]
    );

    journaliser({
      acteurType: "proprietaire",
      acteurId: proprietaire.id,
      proprietaireId: proprietaire.id,
      action: "compte_active",
      cibleType: "compte",
      cibleId: proprietaire.id,
    });

    res.status(201).json({
      token: genererToken(proprietaire.id),
      proprietaireId: proprietaire.id,
      prenom: proprietaire.prenom,
    });
  } catch (erreur) {
    console.error("Erreur création PIN propriétaire :", erreur);
    res.status(500).json({ erreur: "Erreur serveur pendant la création du code." });
  }
}

async function connexion(req, res) {
  const { identifiant, pin } = req.body;

  if (!identifiant || !pin) {
    return res.status(400).json({ erreur: "Identifiant et code PIN requis." });
  }

  try {
    const proprietaire = await chercherParIdentifiant(identifiant);

    if (!proprietaire) {
      return res.status(404).json({ erreur: "Aucun compte trouvé pour ces coordonnées." });
    }

    if (proprietaire.compte_verrouille) {
      return res.status(403).json({
        erreur: "Compte verrouillé. Contactez le support SEDAP pour le débloquer.",
        compteVerrouille: true,
      });
    }

    if (!proprietaire.pin_hash) {
      return res.status(409).json({
        erreur: "Aucun code PIN défini pour ce compte. Activez-le d'abord.",
      });
    }

    const pinCorrect = await bcrypt.compare(pin, proprietaire.pin_hash);

    if (!pinCorrect) {
      const tentatives = proprietaire.tentatives_echouees + 1;
      const verrouiller = tentatives >= TENTATIVES_MAX;

      await pool.query(
        "UPDATE proprietaires SET tentatives_echouees = $1, compte_verrouille = $2 WHERE id = $3",
        [tentatives, verrouiller, proprietaire.id]
      );

      if (verrouiller) {
        journaliser({
          acteurType: "systeme",
          proprietaireId: proprietaire.id,
          action: "compte_verrouille",
          cibleType: "compte",
          cibleId: proprietaire.id,
          details: { motif: `${TENTATIVES_MAX} codes PIN faux` },
        });
        return res.status(403).json({
          erreur: "Compte verrouillé après 3 tentatives. Contactez le support SEDAP.",
          compteVerrouille: true,
        });
      }

      return res.status(401).json({
        erreur: "Code incorrect.",
        tentativesRestantes: TENTATIVES_MAX - tentatives,
      });
    }

    await pool.query(
      "UPDATE proprietaires SET tentatives_echouees = 0 WHERE id = $1",
      [proprietaire.id]
    );

    res.json({
      token: genererToken(proprietaire.id),
      proprietaireId: proprietaire.id,
      prenom: proprietaire.prenom,
    });
  } catch (erreur) {
    console.error("Erreur connexion propriétaire :", erreur);
    res.status(500).json({ erreur: "Erreur serveur pendant la connexion." });
  }
}

async function moi(req, res) {
  try {
    const resultat = await pool.query(
      `SELECT p.id, p.telephone, p.email, p.nom, p.prenom,
              f.id AS ferme_id, f.nom AS ferme_nom
         FROM proprietaires p
         LEFT JOIN fermes f ON f.proprietaire_id = p.id
        WHERE p.id = $1`,
      [req.utilisateur.id]
    );

    if (resultat.rows.length === 0) {
      return res.status(404).json({ erreur: "Propriétaire introuvable." });
    }

    res.json(resultat.rows[0]);
  } catch (erreur) {
    console.error("Erreur /moi propriétaire :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = { verifierIdentite, creerPin, connexion, moi, genererToken };
