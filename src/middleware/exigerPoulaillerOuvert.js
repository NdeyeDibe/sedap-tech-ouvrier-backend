const { obtenirPoulaillerOuvrier } = require("../utils/poulailler");
const { etatPoulailler } = require("../services/verrou");

// Barrage de paiement sur l'application du responsable.
//
// Quand la facture de la bande en cours dépasse son délai (voir
// services/verrou.js), le poulailler se verrouille : plus aucune écriture
// n'est acceptée. Décision Mengué, 26 oct. 2026.
//
// DEUX PRÉCAUTIONS.
//
// 1. Les LECTURES passent toujours. Un responsable verrouillé doit
//    pouvoir ouvrir son application et comprendre ce qui se passe —
//    l'écran de blocage a besoin de lire l'état pour s'afficher. Bloquer
//    aussi les lectures donnerait une application morte, et le
//    responsable conclurait à une panne.
//
// 2. La réponse porte un CODE, pas seulement un message. L'application
//    s'en sert pour afficher son écran « poulailler suspendu » avec la
//    consigne de noter la mortalité sur papier, au lieu d'une erreur
//    rouge incompréhensible.
//
// 423 « Locked » plutôt que 403 : ce n'est pas un défaut de droits, et
// l'état se lève tout seul au paiement.
async function exigerPoulaillerOuvert(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD") return next();

  try {
    const poulaillerId = await obtenirPoulaillerOuvrier(req.ouvrierId);
    if (!poulaillerId) return next();

    const etat = await etatPoulailler(poulaillerId);
    if (etat.etape !== "verrouille") return next();

    return res.status(423).json({
      code: "poulailler_verrouille",
      erreur:
        "Ce poulailler est suspendu : la facture de la bande en cours n'a pas été réglée. " +
        "Préviens le propriétaire. Note la mortalité de chaque jour sur un papier — " +
        "elle sera saisie dès que le compte sera rouvert.",
      facture: etat.facture
        ? { bandeNumero: etat.facture.bandeNumero, montant: etat.facture.montant }
        : null,
    });
  } catch (erreur) {
    // Un incident de base ne doit pas bloquer un responsable à jour de
    // ses paiements : en cas de doute, on laisse passer. Le verrou est un
    // levier commercial, pas une barrière de sécurité.
    console.error("Vérification du verrou impossible :", erreur.message);
    next();
  }
}

module.exports = exigerPoulaillerOuvert;
