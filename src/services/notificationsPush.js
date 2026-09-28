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

// Envoie une notification à tous les appareils d'un destinataire.
// « type » sert à respecter ses réglages (ex. alertes mortalité coupées).
//
// La colonne change selon qu'on écrit à un propriétaire ou à un admin ; le
// reste — préférences, purge des abonnements périmés — est identique, d'où
// une seule fonction.
async function notifier(colonne, id, contenu, type = null) {
  if (!pushActif) return 0;

  const { rows } = await pool.query(
    `SELECT id, endpoint, p256dh, auth, preferences
       FROM abonnements_push
      WHERE ${colonne} = $1`,
    [id]
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

const notifierProprietaire = (id, contenu, type = null) =>
  notifier("proprietaire_id", id, contenu, type);

const notifierAdmin = (id, contenu, type = null) =>
  notifier("admin_id", id, contenu, type);

module.exports = {
  pushActif,
  notifierProprietaire,
  notifierAdmin,
  VAPID_PUBLIC_KEY,
};
