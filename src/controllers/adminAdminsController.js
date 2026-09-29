const pool = require("../db/pool");
const { parAdmin } = require("../services/journal");
const { nouveauJeton } = require("../utils/motDePasse");
const { envoyer } = require("../services/email");
const { invitationAdmin } = require("../services/emailModeles");

// Comptes administrateurs — cahier admin, maquette 23.
//
// Réservé à l'admin principal. Un nouvel admin ne reçoit pas de mot de
// passe : il reçoit un lien valable 24 h pour en choisir un. SEDAP ne
// connaît jamais le mot de passe de quelqu'un — c'est déjà la règle pour
// les codes PIN des ouvriers et des propriétaires.
//
// Deux verrous que l'écran annonce :
//  - on ne désactive pas son propre compte (on se mettrait dehors) ;
//  - on ne désactive pas le dernier admin principal actif (plus personne
//    ne pourrait gérer les comptes, ni les seuils, ni le programme).

const HEURES_VALIDITE_LIEN = 24;

const ROLES = ["admin", "admin_principal"];

const texte = (v) => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};

const ADMIN_URL = process.env.ADMIN_URL || null;

function lienInvitation(jeton, admin) {
  const lien = ADMIN_URL
    ? `${ADMIN_URL.replace(/\/$/, "")}/reinitialiser?jeton=${jeton}`
    : null;

  const message =
    `Bonjour ${admin.prenom}, votre accès à l'interface SEDAP'Tech est prêt. ` +
    (lien ? `Ouvrez ${lien} ` : "Ouvrez l'interface admin SEDAP'Tech ") +
    `pour choisir votre mot de passe. Ce lien est valable 24 heures.`;

  return { jeton, lien, message, expireLe: admin.jeton_expire_le };
}

/**
 * Compose le lien puis l'envoie par e-mail. Le message reste renvoyé à
 * l'écran quoi qu'il arrive : si l'envoi échoue, l'admin principal le
 * transmet à la main, comme avant.
 */
async function delivrerInvitation(jeton, admin) {
  const invitation = lienInvitation(jeton, admin);

  const envoi = invitation.lien
    ? await envoyer({
        a: admin.email,
        ...invitationAdmin({ prenom: admin.prenom, lien: invitation.lien }),
      })
    : "non_configure"; // sans ADMIN_URL, le lien n'existe pas : rien à envoyer

  return { ...invitation, envoi, destinataire: admin.email };
}

function profil(a) {
  return {
    id: a.id,
    prenom: a.prenom,
    nom: a.nom,
    email: a.email,
    role: a.role,
    actif: a.actif,
    creeLe: a.cree_le,
    derniereConnexion: a.derniere_connexion,
    // « En attente » : compte créé, mot de passe jamais choisi. Le lien
    // court toujours si sa date n'est pas passée.
    enAttente: a.mot_de_passe_hash === null,
    lienExpireLe: a.jeton_expire_le,
  };
}

// GET /api/admin/administrateurs
async function listeAdmins(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT id, prenom, nom, email, role, actif, cree_le, derniere_connexion,
              mot_de_passe_hash, jeton_expire_le
         FROM admins
        ORDER BY actif DESC, role, prenom, nom`
    );

    res.json({
      admins: rows.map(profil),
      moi: req.utilisateur.id,
      // Ce chiffre commande le verrou : le dernier admin principal actif ne
      // se désactive pas.
      principauxActifs: rows.filter((a) => a.actif && a.role === "admin_principal").length,
    });
  } catch (erreur) {
    console.error("Erreur liste des admins :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// POST /api/admin/administrateurs
async function creerAdmin(req, res) {
  const prenom = texte(req.body.prenom);
  const nom = texte(req.body.nom);
  const email = texte(req.body.email)?.toLowerCase() ?? null;
  const role = texte(req.body.role) ?? "admin";

  if (!prenom || !nom) return res.status(400).json({ erreur: "Prénom et nom requis." });
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ erreur: "Adresse e-mail invalide." });
  }
  if (!ROLES.includes(role)) return res.status(400).json({ erreur: "Rôle inconnu." });

  try {
    // La base ne garde que l'empreinte : c'est elle que cherche
    // adminAuthController.reinitialiser, et une fuite de la table admins ne
    // donnerait aucun lien utilisable.
    const { jeton, empreinte } = nouveauJeton();

    const { rows } = await pool.query(
      `INSERT INTO admins (prenom, nom, email, role, actif, cree_par,
                           jeton_reinitialisation, jeton_expire_le)
            VALUES ($1, $2, $3, $4, true, $5, $6,
                    now() + ($7 || ' hours')::interval)
         RETURNING id, prenom, nom, email, role, actif, cree_le, derniere_connexion,
                   mot_de_passe_hash, jeton_expire_le`,
      [prenom, nom, email, role, req.utilisateur.id, empreinte, String(HEURES_VALIDITE_LIEN)]
    );

    parAdmin(req, {
      action: "admin_cree",
      cibleType: "admin",
      cibleId: rows[0].id,
      details: { email, role },
    });

    res.status(201).json({
      admin: profil(rows[0]),
      invitation: await delivrerInvitation(jeton, rows[0]),
    });
  } catch (erreur) {
    if (erreur.code === "23505") {
      return res.status(409).json({ erreur: "Cette adresse e-mail est déjà utilisée." });
    }
    console.error("Erreur création d'admin :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// PATCH /api/admin/administrateurs/:id — identité et rôle.
async function modifierAdmin(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erreur: "Identifiant invalide." });

  const prenom = texte(req.body.prenom);
  const nom = texte(req.body.nom);
  const email = texte(req.body.email)?.toLowerCase() ?? null;
  const role = req.body.role === undefined ? undefined : texte(req.body.role);

  if (!prenom || !nom) return res.status(400).json({ erreur: "Prénom et nom requis." });
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ erreur: "Adresse e-mail invalide." });
  }
  if (role !== undefined && !ROLES.includes(role)) {
    return res.status(400).json({ erreur: "Rôle inconnu." });
  }

  try {
    // Se retirer soi-même le rôle principal revient à se fermer la porte :
    // plus personne ne pourrait rendre le rôle, si on était le dernier.
    if (role === "admin" && id === req.utilisateur.id) {
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM admins WHERE actif AND role = 'admin_principal' AND id <> $1",
        [id]
      );
      if (rows[0].n === 0) {
        return res.status(409).json({
          erreur: "Vous êtes le dernier admin principal actif : nommez-en un autre d'abord.",
        });
      }
    }

    const { rows } = await pool.query(
      `UPDATE admins
          SET prenom = $2, nom = $3, email = $4, role = coalesce($5, role)
        WHERE id = $1
        RETURNING id, prenom, nom, email, role, actif, cree_le, derniere_connexion,
                  mot_de_passe_hash, jeton_expire_le`,
      [id, prenom, nom, email, role ?? null]
    );
    if (!rows[0]) return res.status(404).json({ erreur: "Admin introuvable." });

    parAdmin(req, {
      action: "admin_modifie",
      cibleType: "admin",
      cibleId: id,
      details: { email, role: rows[0].role },
    });

    res.json({ admin: profil(rows[0]) });
  } catch (erreur) {
    if (erreur.code === "23505") {
      return res.status(409).json({ erreur: "Cette adresse e-mail est déjà utilisée." });
    }
    console.error("Erreur modification d'admin :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// PATCH /api/admin/administrateurs/:id/actif
async function changerActivite(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erreur: "Identifiant invalide." });

  const actif = req.body.actif;
  if (typeof actif !== "boolean") return res.status(400).json({ erreur: "État attendu." });

  try {
    if (!actif) {
      if (id === req.utilisateur.id) {
        return res.status(409).json({ erreur: "Vous ne pouvez pas désactiver votre propre compte." });
      }

      const { rows } = await pool.query(
        "SELECT role, actif FROM admins WHERE id = $1",
        [id]
      );
      if (!rows[0]) return res.status(404).json({ erreur: "Admin introuvable." });

      if (rows[0].role === "admin_principal" && rows[0].actif) {
        const { rows: restants } = await pool.query(
          "SELECT count(*)::int AS n FROM admins WHERE actif AND role = 'admin_principal' AND id <> $1",
          [id]
        );
        if (restants[0].n === 0) {
          return res.status(409).json({
            erreur: "C'est le dernier admin principal actif : il ne peut pas être désactivé.",
          });
        }
      }
    }

    const { rows } = await pool.query(
      `UPDATE admins SET actif = $2 WHERE id = $1
        RETURNING id, prenom, nom, email, role, actif, cree_le, derniere_connexion,
                  mot_de_passe_hash, jeton_expire_le`,
      [id, actif]
    );
    if (!rows[0]) return res.status(404).json({ erreur: "Admin introuvable." });

    parAdmin(req, {
      action: actif ? "admin_reactive" : "admin_desactive",
      cibleType: "admin",
      cibleId: id,
      details: {},
    });

    res.json({ admin: profil(rows[0]) });
  } catch (erreur) {
    console.error("Erreur activation d'admin :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// POST /api/admin/administrateurs/:id/renvoyer-lien
async function renvoyerLien(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erreur: "Identifiant invalide." });

  try {
    const { jeton, empreinte } = nouveauJeton();

    const { rows } = await pool.query(
      `UPDATE admins
          SET jeton_reinitialisation = $2,
              jeton_expire_le = now() + ($3 || ' hours')::interval
        WHERE id = $1
        RETURNING id, prenom, nom, email, mot_de_passe_hash, jeton_expire_le`,
      [id, empreinte, String(HEURES_VALIDITE_LIEN)]
    );
    if (!rows[0]) return res.status(404).json({ erreur: "Admin introuvable." });

    parAdmin(req, {
      action: "admin_lien_renvoye",
      cibleType: "admin",
      cibleId: id,
      details: {},
    });

    res.json({ invitation: await delivrerInvitation(jeton, rows[0]) });
  } catch (erreur) {
    console.error("Erreur renvoi du lien admin :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = { listeAdmins, creerAdmin, modifierAdmin, changerActivite, renvoyerLien };
