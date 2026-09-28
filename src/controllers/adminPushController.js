const pool = require("../db/pool");
const {
  pushActif,
  notifierAdmin,
  VAPID_PUBLIC_KEY,
} = require("../services/notificationsPush");

// Notifications push de l'admin — cahier admin, maquette 19.
//
// Même mécanique que côté propriétaire, sur la même table (migration 022).
// Ce qui change : le destinataire, et les types qu'on peut couper.
//
// Les alertes rouges ne se coupent pas. Elles n'apparaissent pas dans les
// réglages de la maquette, et c'est voulu : une mortalité qui explose ou un
// stock d'aliment à sec doivent réveiller quelqu'un, sinon la notification
// ne sert à rien. Seules les alertes orange se désactivent.
const TYPES_REGLABLES = ["mortalite", "aliment"];

function clePublique(req, res) {
  if (!pushActif) {
    return res.status(503).json({ erreur: "Notifications non configurées sur le serveur." });
  }
  res.json({ cle: VAPID_PUBLIC_KEY });
}

// Ne garde que les réglages connus, et seulement des booléens : une
// préférence inventée par le navigateur n'a rien à faire en base.
function preferencesPropres(brutes) {
  const propres = {};
  for (const type of TYPES_REGLABLES) {
    if (typeof brutes?.[type] === "boolean") propres[type] = brutes[type];
  }
  return propres;
}

// POST /api/admin/push/abonner
async function abonner(req, res) {
  const { abonnement, preferences } = req.body;
  const endpoint = abonnement?.endpoint;
  const { p256dh, auth } = abonnement?.keys ?? {};

  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ erreur: "Abonnement invalide." });
  }

  try {
    // Un endpoint appartient à un navigateur. S'il change de compte — un
    // admin se déconnecte, un autre se connecte sur la même tablette — il
    // suit le compte connecté, et cesse d'appartenir au précédent.
    await pool.query(
      `INSERT INTO abonnements_push
         (admin_id, proprietaire_id, endpoint, p256dh, auth, preferences)
       VALUES ($1, NULL, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
         SET admin_id = EXCLUDED.admin_id,
             proprietaire_id = NULL,
             p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth,
             preferences = EXCLUDED.preferences,
             maj_le = now()`,
      [req.utilisateur.id, endpoint, p256dh, auth, preferencesPropres(preferences)]
    );

    res.status(201).json({ abonne: true });
  } catch (erreur) {
    console.error("Erreur abonnement push admin :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// PATCH /api/admin/push/preferences — les interrupteurs de la maquette.
async function modifierPreferences(req, res) {
  const { endpoint, preferences } = req.body;
  if (!endpoint) return res.status(400).json({ erreur: "Appareil non identifié." });

  try {
    const { rowCount } = await pool.query(
      `UPDATE abonnements_push
          SET preferences = $3, maj_le = now()
        WHERE endpoint = $1 AND admin_id = $2`,
      [endpoint, req.utilisateur.id, preferencesPropres(preferences)]
    );

    if (rowCount === 0) {
      return res.status(404).json({ erreur: "Cet appareil n'est pas abonné." });
    }

    res.json({ preferences: preferencesPropres(preferences) });
  } catch (erreur) {
    console.error("Erreur préférences push admin :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// DELETE /api/admin/push/abonner
async function desabonner(req, res) {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ erreur: "Appareil non identifié." });

  try {
    await pool.query(
      "DELETE FROM abonnements_push WHERE endpoint = $1 AND admin_id = $2",
      [endpoint, req.utilisateur.id]
    );
    res.status(204).end();
  } catch (erreur) {
    console.error("Erreur désabonnement push admin :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// GET /api/admin/push/etat?endpoint=… — ce que le serveur sait de cet
// appareil. Le navigateur connaît sa permission ; lui seul ne suffit pas à
// savoir si l'abonnement est bien arrivé jusqu'ici.
async function etat(req, res) {
  const endpoint = String(req.query.endpoint ?? "");
  if (!endpoint) return res.json({ actif: pushActif, abonne: false, preferences: {} });

  try {
    const { rows } = await pool.query(
      "SELECT preferences FROM abonnements_push WHERE endpoint = $1 AND admin_id = $2",
      [endpoint, req.utilisateur.id]
    );

    res.json({
      actif: pushActif,
      abonne: rows.length > 0,
      preferences: rows[0]?.preferences ?? {},
    });
  } catch (erreur) {
    console.error("Erreur état push admin :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// POST /api/admin/push/test — « Envoyer un essai » (maquette 19).
async function tester(req, res) {
  try {
    const envoyees = await notifierAdmin(req.utilisateur.id, {
      titre: "SEDAP'Tech",
      corps: "Notification d'essai : tout fonctionne sur cet appareil.",
      url: "/alertes",
    });

    if (envoyees === 0) {
      return res.status(409).json({
        erreur: pushActif
          ? "Aucun appareil abonné. Activez les notifications sur cet appareil d'abord."
          : "Notifications non configurées sur le serveur.",
      });
    }

    res.json({ envoyees });
  } catch (erreur) {
    console.error("Erreur notification d'essai admin :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = {
  clePublique,
  abonner,
  modifierPreferences,
  desabonner,
  etat,
  tester,
  TYPES_REGLABLES,
};
