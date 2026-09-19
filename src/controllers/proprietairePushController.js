const pool = require("../db/pool");
const {
  pushActif,
  notifierProprietaire,
  VAPID_PUBLIC_KEY,
} = require("../services/notificationsPush");

// Le téléphone a besoin de la clé publique du serveur pour s'abonner.
function clePublique(req, res) {
  if (!pushActif) {
    return res
      .status(503)
      .json({ erreur: "Notifications non configurées sur le serveur." });
  }
  res.json({ cle: VAPID_PUBLIC_KEY });
}

// Enregistre (ou met à jour) l'abonnement de ce téléphone.
async function abonner(req, res) {
  const { abonnement, preferences } = req.body;
  const endpoint = abonnement?.endpoint;
  const { p256dh, auth } = abonnement?.keys ?? {};

  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ erreur: "Abonnement invalide." });
  }

  try {
    // Un endpoint est propre à un navigateur : s'il change de propriétaire
    // (déconnexion puis autre compte), il suit le compte connecté.
    await pool.query(
      `INSERT INTO abonnements_push
         (proprietaire_id, endpoint, p256dh, auth, preferences)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
         SET proprietaire_id = EXCLUDED.proprietaire_id,
             p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth,
             preferences = EXCLUDED.preferences,
             maj_le = now()`,
      [req.utilisateur.id, endpoint, p256dh, auth, preferences ?? {}]
    );
    res.status(201).json({ abonne: true });
  } catch (erreur) {
    console.error("Erreur abonnement push :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

async function desabonner(req, res) {
  const { endpoint } = req.body;

  try {
    await pool.query(
      `DELETE FROM abonnements_push
        WHERE endpoint = $1 AND proprietaire_id = $2`,
      [endpoint, req.utilisateur.id]
    );
    res.status(204).end();
  } catch (erreur) {
    console.error("Erreur désabonnement push :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// Notification d'essai, pour vérifier que tout fonctionne sur ce téléphone.
async function tester(req, res) {
  try {
    const envoyees = await notifierProprietaire(req.utilisateur.id, {
      titre: "SEDAP'Tech",
      corps: "Les notifications fonctionnent sur ce téléphone.",
      url: "/alertes",
    });
    res.json({ envoyees });
  } catch (erreur) {
    console.error("Erreur notification d'essai :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = { clePublique, abonner, desabonner, tester };
