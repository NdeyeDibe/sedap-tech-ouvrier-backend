const webpush = require("web-push");
const pool = require("../db/pool");

// Envoi des notifications push (écran verrouillé, appli fermée).
//
// Les clés VAPID identifient notre serveur auprès des services de push
// (Google, Apple, Mozilla). Elles se génèrent une seule fois avec :
//   npx web-push generate-vapid-keys
// puis se placent dans .env en local et dans les variables Railway.
const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_CONTACT } = process.env;

const pushActif = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushActif) {
  webpush.setVapidDetails(
    VAPID_CONTACT || "mailto:contact@sedap.sn",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
} else {
  console.warn("⚠️  Notifications push désactivées : clés VAPID absentes.");
}

// Envoie une notification à tous les appareils d'un propriétaire.
// « type » sert à respecter ses réglages (ex. alertes mortalité coupées).
async function notifierProprietaire(proprietaireId, contenu, type = null) {
  if (!pushActif) return 0;

  const { rows } = await pool.query(
    `SELECT id, endpoint, p256dh, auth, preferences
       FROM abonnements_push
      WHERE proprietaire_id = $1`,
    [proprietaireId]
  );

  let envoyees = 0;

  for (const abonnement of rows) {
    if (type && abonnement.preferences?.[type] === false) continue;

    try {
      await webpush.sendNotification(
        {
          endpoint: abonnement.endpoint,
          keys: { p256dh: abonnement.p256dh, auth: abonnement.auth },
        },
        JSON.stringify(contenu),
        { TTL: 12 * 3600 }
      );
      envoyees += 1;
    } catch (erreur) {
      // 404 / 410 : l'abonnement n'existe plus (appli désinstallée,
      // permission retirée). On l'oublie.
      if (erreur.statusCode === 404 || erreur.statusCode === 410) {
        await pool.query("DELETE FROM abonnements_push WHERE id = $1", [
          abonnement.id,
        ]);
      } else {
        console.error("Échec d'envoi push :", erreur.statusCode, erreur.body);
      }
    }
  }

  return envoyees;
}

module.exports = { pushActif, notifierProprietaire, VAPID_PUBLIC_KEY };
