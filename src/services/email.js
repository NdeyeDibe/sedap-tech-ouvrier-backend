// Envoi d'e-mails transactionnels — liens d'accès, et rien d'autre.
//
// SEDAP n'envoie pas de lettres d'information : tous les messages qui
// partent d'ici portent un lien qu'une personne attend (un accès à choisir,
// un code à recréer). C'est ce qui permet de tenir un envoi simple, sans
// désabonnement ni suivi d'ouverture.
//
// Fournisseur : Resend (API HTTP, pas de SMTP à configurer). Changer de
// fournisseur ne demande de retoucher que `poster()` ci-dessous ; le reste
// de l'application ne connaît que `envoyer()`.
//
// Deux règles qui gouvernent tout ce fichier :
//
//  1. un envoi ne fait jamais échouer l'action qui l'a déclenché. Créer un
//     propriétaire doit réussir même si Resend est en panne : le lien
//     reste affiché à l'écran, SEDAP le transmet à la main ;
//  2. l'état de l'envoi remonte toujours à l'interface, pour qu'elle dise
//     la vérité — « envoyé à x@y » ou « non envoyé, copiez le lien ».

const CLE = process.env.RESEND_API_KEY || null;

// « SEDAP'Tech <noreply@sedaptech.com> ». Le domaine doit être vérifié chez
// Resend, sinon l'envoi est refusé.
const EXPEDITEUR = process.env.EMAIL_EXPEDITEUR || "SEDAP'Tech <noreply@sedaptech.com>";

// Adresse à laquelle une réponse arrive vraiment. Sans elle, répondre à un
// message SEDAP tombe dans le vide.
const REPONDRE_A = process.env.EMAIL_REPONSE || null;

const DELAI_MAX_MS = 10000;

/** Les quatre issues possibles, telles que l'interface les affiche. */
const ETATS = {
  envoye: "envoye",
  sansAdresse: "sans_adresse",
  nonConfigure: "non_configure",
  echec: "echec",
};

/** Vrai quand une clé est en place : l'interface peut proposer l'envoi. */
function envoiConfigure() {
  return Boolean(CLE);
}

/**
 * Envoie un message. Ne lève jamais.
 *
 * @returns {Promise<string>} l'un des ETATS.
 */
async function envoyer({ a, sujet, texte, html }) {
  if (!a) return ETATS.sansAdresse;

  if (!CLE) {
    // Sans clé, on garde le comportement d'avant : le lien passe dans les
    // journaux Railway, que seule l'équipe SEDAP lit.
    console.info(`[e-mail non configuré] « ${sujet} » aurait été envoyé à ${a}`);
    return ETATS.nonConfigure;
  }

  try {
    const reponse = await poster({ a, sujet, texte, html });

    if (!reponse.ok) {
      const corps = await reponse.text().catch(() => "");
      console.error(`[e-mail] refus du fournisseur (${reponse.status}) pour ${a} : ${corps}`);
      return ETATS.echec;
    }

    console.info(`[e-mail] « ${sujet} » envoyé à ${a}`);
    return ETATS.envoye;
  } catch (erreur) {
    // Panne réseau, délai dépassé : l'action appelante continue.
    console.error(`[e-mail] envoi impossible à ${a} :`, erreur.message);
    return ETATS.echec;
  }
}

// Le seul endroit qui connaît Resend.
function poster({ a, sujet, texte, html }) {
  const abandon = AbortSignal.timeout(DELAI_MAX_MS);

  return fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: abandon,
    headers: {
      Authorization: `Bearer ${CLE}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EXPEDITEUR,
      to: [a],
      subject: sujet,
      text: texte,
      html,
      ...(REPONDRE_A ? { reply_to: REPONDRE_A } : {}),
    }),
  });
}

module.exports = { envoyer, envoiConfigure, ETATS };
