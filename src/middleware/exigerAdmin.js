const pool = require("../db/pool");
const { verifierToken, exigerRole } = require("./auth");

// Garde de toutes les routes /api/admin, sauf l'authentification.
//
// Le jeton seul ne suffit pas : il vaut 12 heures, et un admin désactivé
// entre-temps (Paramètres → Administrateurs) doit perdre l'accès tout de
// suite, pas à l'expiration. On relit donc son état à chaque requête — une
// ligne par clé primaire, le coût est négligeable.
async function adminToujoursActif(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT role, actif FROM admins WHERE id = $1",
      [req.utilisateur.id]
    );
    const admin = rows[0];

    if (!admin || !admin.actif) {
      return res.status(401).json({ erreur: "Session invalide, reconnectez-vous." });
    }

    // Le rôle fait foi en base : un admin principal rétrogradé perd ses
    // droits sans attendre un nouveau jeton.
    req.utilisateur.role = admin.role;
    next();
  } catch (erreur) {
    console.error("Erreur vérification admin :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// Tout admin connecté et actif.
const exigerAdmin = [
  verifierToken,
  exigerRole("admin", "admin_principal"),
  adminToujoursActif,
];

// Routes marquées ★ dans l'annexe A : seuils, programme, comptes admin.
// À placer APRÈS exigerAdmin.
const exigerAdminPrincipal = exigerRole("admin_principal");

module.exports = { exigerAdmin, exigerAdminPrincipal };
