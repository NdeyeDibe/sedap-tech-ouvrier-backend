const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");
const {
  motDePasseFaible,
  nouveauJeton,
  empreinteJeton,
} = require("../utils/motDePasse");

// Authentification des admins SEDAP — cahier admin v1.1, section III.
// E-mail + mot de passe, jeton de 12 heures, blocage 15 minutes après
// 5 échecs consécutifs. Aucune inscription : les comptes naissent du script
// initial ou de Paramètres → Administrateurs.

const TOUR_DE_HACHAGE = 10;
const ECHECS_MAX = 5;
const MINUTES_BLOCAGE = 15;
const DUREE_JETON = "12h";
const DUREE_LIEN_OUBLI_MIN = 60;

// Adresse du front admin, pour construire le lien du mot de passe oublié.
const URL_ADMIN = process.env.ADMIN_URL || "http://localhost:5173";

// Empreinte bcrypt factice : comparer contre elle quand l'e-mail est inconnu
// prend le même temps qu'une vraie vérification. Sans ça, la durée de la
// réponse suffirait à deviner quelles adresses ont un compte.
const EMPREINTE_FACTICE = bcrypt.hashSync("aucun-compte", TOUR_DE_HACHAGE);

function genererToken(admin) {
  return jwt.sign({ id: admin.id, role: admin.role }, process.env.JWT_SECRET, {
    expiresIn: DUREE_JETON,
  });
}

function profil(admin) {
  return {
    id: admin.id,
    email: admin.email,
    prenom: admin.prenom,
    nom: admin.nom,
    role: admin.role,
    derniereConnexion: admin.derniere_connexion,
  };
}

// Même message pour un e-mail inconnu et un mauvais mot de passe : l'écran de
// connexion ne doit pas servir à vérifier qui a un compte.
const IDENTIFIANTS_INCORRECTS = "E-mail ou mot de passe incorrect.";

// ------------------------------------------------------------ connexion

// POST /api/admin/auth/connexion
async function connexion(req, res) {
  const { email, motDePasse } = req.body;

  if (!email || !motDePasse) {
    return res.status(400).json({ erreur: "E-mail et mot de passe requis." });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, email, prenom, nom, role, actif, mot_de_passe_hash,
              tentatives_echouees, bloque_jusqua, derniere_connexion
         FROM admins
        WHERE lower(email) = lower($1)`,
      [String(email).trim()]
    );
    const admin = rows[0];

    if (!admin) {
      await bcrypt.compare(String(motDePasse), EMPREINTE_FACTICE);
      return res.status(401).json({ erreur: IDENTIFIANTS_INCORRECTS });
    }

    if (admin.bloque_jusqua && new Date(admin.bloque_jusqua) > new Date()) {
      const minutes = Math.ceil((new Date(admin.bloque_jusqua) - new Date()) / 60000);
      return res.status(423).json({
        erreur: `Trop d'essais. Réessayez dans ${minutes} minute${minutes > 1 ? "s" : ""}.`,
        minutesRestantes: minutes,
      });
    }

    if (!admin.actif) {
      return res.status(403).json({ erreur: "Ce compte admin est désactivé." });
    }

    if (!admin.mot_de_passe_hash) {
      return res.status(409).json({
        erreur: "Compte pas encore activé : utilisez le lien reçu pour choisir votre mot de passe.",
      });
    }

    const correct = await bcrypt.compare(String(motDePasse), admin.mot_de_passe_hash);

    if (!correct) {
      const echecs = admin.tentatives_echouees + 1;
      const bloquer = echecs >= ECHECS_MAX;

      // Le compteur repart à zéro avec le blocage : après 15 minutes, l'admin
      // a de nouveau 5 essais, et non un seul.
      await pool.query(
        `UPDATE admins
            SET tentatives_echouees = $1,
                bloque_jusqua = CASE WHEN $2 THEN now() + ($3 || ' minutes')::interval
                                     ELSE bloque_jusqua END
          WHERE id = $4`,
        [bloquer ? 0 : echecs, bloquer, MINUTES_BLOCAGE, admin.id]
      );

      if (bloquer) {
        return res.status(423).json({
          erreur: `Trop d'essais. Connexion bloquée ${MINUTES_BLOCAGE} minutes.`,
          minutesRestantes: MINUTES_BLOCAGE,
        });
      }

      return res.status(401).json({
        erreur: IDENTIFIANTS_INCORRECTS,
        essaisRestants: ECHECS_MAX - echecs,
      });
    }

    const { rows: misAJour } = await pool.query(
      `UPDATE admins
          SET tentatives_echouees = 0, bloque_jusqua = NULL, derniere_connexion = now()
        WHERE id = $1
        RETURNING id, email, prenom, nom, role, derniere_connexion`,
      [admin.id]
    );

    res.json({ token: genererToken(admin), admin: profil(misAJour[0]) });
  } catch (erreur) {
    console.error("Erreur connexion admin :", erreur);
    res.status(500).json({ erreur: "Erreur serveur pendant la connexion." });
  }
}

// ------------------------------------------------- mot de passe oublié

// POST /api/admin/auth/mot-de-passe-oublie
//
// Répond toujours de la même façon, que l'e-mail existe ou non.
async function motDePasseOublie(req, res) {
  const { email } = req.body;
  const REPONSE = {
    message: "Si cette adresse a un compte, un lien vient d'y être envoyé. Il est valable 1 heure.",
  };

  if (!email) {
    return res.status(400).json({ erreur: "E-mail requis." });
  }

  try {
    const { rows } = await pool.query(
      "SELECT id, email, actif FROM admins WHERE lower(email) = lower($1)",
      [String(email).trim()]
    );
    const admin = rows[0];

    if (!admin || !admin.actif) return res.json(REPONSE);

    const { jeton, empreinte } = nouveauJeton();

    await pool.query(
      `UPDATE admins
          SET jeton_reinitialisation = $1,
              jeton_expire_le = now() + ($2 || ' minutes')::interval
        WHERE id = $3`,
      [empreinte, DUREE_LIEN_OUBLI_MIN, admin.id]
    );

    const lien = `${URL_ADMIN}/reinitialiser?jeton=${jeton}`;

    // TODO(ENVOI) : aucun service d'e-mail n'est encore branché. En attendant,
    // le lien apparaît dans les logs Railway, que seule l'équipe SEDAP lit.
    // À remplacer par l'envoi réel dès que le service existe.
    console.info(`[mot de passe oublié] lien pour ${admin.email} : ${lien}`);

    res.json(REPONSE);
  } catch (erreur) {
    console.error("Erreur mot de passe oublié :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// POST /api/admin/auth/reinitialiser
//
// Sert aux deux liens : mot de passe oublié (1 h) et premier mot de passe
// d'un admin invité (24 h, cahier XI.5). Dans les deux cas le lien est à
// usage unique et le compte est débloqué.
async function reinitialiser(req, res) {
  const { jeton, motDePasse } = req.body;

  if (!jeton || !motDePasse) {
    return res.status(400).json({ erreur: "Lien et nouveau mot de passe requis." });
  }

  const probleme = motDePasseFaible(motDePasse);
  if (probleme) return res.status(400).json({ erreur: probleme });

  try {
    const hash = await bcrypt.hash(motDePasse, TOUR_DE_HACHAGE);

    const { rows } = await pool.query(
      `UPDATE admins
          SET mot_de_passe_hash = $1,
              jeton_reinitialisation = NULL,
              jeton_expire_le = NULL,
              tentatives_echouees = 0,
              bloque_jusqua = NULL
        WHERE jeton_reinitialisation = $2
          AND jeton_expire_le > now()
          AND actif
        RETURNING id`,
      [hash, empreinteJeton(jeton)]
    );

    if (rows.length === 0) {
      return res.status(410).json({
        erreur: "Ce lien n'est plus valable. Demandez-en un nouveau.",
      });
    }

    res.json({ message: "Mot de passe enregistré. Vous pouvez vous connecter." });
  } catch (erreur) {
    console.error("Erreur réinitialisation admin :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// ------------------------------------------------------------ mon compte

// GET /api/admin/auth/moi
async function moi(req, res) {
  try {
    const { rows } = await pool.query(
      "SELECT id, email, prenom, nom, role, derniere_connexion FROM admins WHERE id = $1",
      [req.utilisateur.id]
    );
    if (rows.length === 0) return res.status(404).json({ erreur: "Admin introuvable." });
    res.json(profil(rows[0]));
  } catch (erreur) {
    console.error("Erreur /moi admin :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// PATCH /api/admin/auth/moi — prénom, nom, e-mail (cahier XI.1)
async function modifierMoi(req, res) {
  const { prenom, nom, email } = req.body;

  if (email !== undefined && !String(email).includes("@")) {
    return res.status(400).json({ erreur: "Adresse e-mail invalide." });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE admins
          SET prenom = coalesce($1, prenom),
              nom    = coalesce($2, nom),
              email  = coalesce(lower($3), email)
        WHERE id = $4
        RETURNING id, email, prenom, nom, role, derniere_connexion`,
      [
        prenom != null ? String(prenom).trim() : null,
        nom != null ? String(nom).trim() : null,
        email != null ? String(email).trim() : null,
        req.utilisateur.id,
      ]
    );
    res.json(profil(rows[0]));
  } catch (erreur) {
    if (erreur.code === "23505") {
      return res.status(409).json({ erreur: "Cette adresse e-mail est déjà utilisée." });
    }
    console.error("Erreur modification compte admin :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// PATCH /api/admin/auth/mot-de-passe — mot de passe actuel, puis nouveau
async function modifierMotDePasse(req, res) {
  const { actuel, nouveau } = req.body;

  if (!actuel || !nouveau) {
    return res.status(400).json({ erreur: "Mot de passe actuel et nouveau requis." });
  }

  const probleme = motDePasseFaible(nouveau);
  if (probleme) return res.status(400).json({ erreur: probleme });

  try {
    const { rows } = await pool.query(
      "SELECT mot_de_passe_hash FROM admins WHERE id = $1",
      [req.utilisateur.id]
    );
    const hash = rows[0]?.mot_de_passe_hash;

    if (!hash || !(await bcrypt.compare(String(actuel), hash))) {
      return res.status(401).json({ erreur: "Mot de passe actuel incorrect." });
    }

    await pool.query("UPDATE admins SET mot_de_passe_hash = $1 WHERE id = $2", [
      await bcrypt.hash(nouveau, TOUR_DE_HACHAGE),
      req.utilisateur.id,
    ]);

    res.json({ message: "Mot de passe modifié." });
  } catch (erreur) {
    console.error("Erreur changement de mot de passe admin :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = {
  connexion,
  motDePasseOublie,
  reinitialiser,
  moi,
  modifierMoi,
  modifierMotDePasse,
};
