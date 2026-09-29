// Les messages que SEDAP envoie. Trois seulement, et tous bâtis pareil :
// une phrase qui dit de quoi il s'agit, un bouton, le lien en clair, une
// durée de validité.
//
// Le lien est écrit deux fois — bouton et texte — parce que plusieurs
// clients de messagerie (et beaucoup de téléphones d'entrée de gamme, ce
// qui compte ici) n'affichent pas les boutons.
//
// Chaque modèle renvoie { sujet, texte, html }, prêt pour services/email.js.

const MARQUE = "SEDAP'Tech";

// ------------------------------------------------------------- gabarit

// Styles en ligne : les feuilles de style sont ignorées par Gmail comme par
// Outlook. Tableau de centrage plutôt que flexbox, pour la même raison.
function gabarit({ titre, phrases, lien, bouton, pied }) {
  const corps = phrases
    .map(
      (p) =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#1f2421">${p}</p>`
    )
    .join("");

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f4f6f4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f4;padding:28px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden">

<tr><td style="background:#12432a;padding:22px 28px">
<span style="font-size:19px;font-weight:700;color:#ffffff;letter-spacing:-0.01em">${MARQUE}</span>
</td></tr>

<tr><td style="padding:28px">
<h1 style="margin:0 0 16px;font-size:21px;line-height:1.3;color:#1f2421">${titre}</h1>
${corps}

<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0"><tr>
<td style="background:#1f7a4d;border-radius:12px">
<a href="${lien}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${bouton}</a>
</td></tr></table>

<p style="margin:0 0 6px;font-size:13px;color:#5c6660">Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :</p>
<p style="margin:0;font-size:13px;word-break:break-all"><a href="${lien}" style="color:#1f7a4d">${lien}</a></p>
</td></tr>

<tr><td style="padding:0 28px 26px">
<p style="margin:0;padding-top:18px;border-top:1px solid #e4e8e5;font-size:12px;line-height:1.6;color:#8a938d">${pied}</p>
</td></tr>

</table></td></tr></table></body></html>`;
}

function versionTexte({ titre, phrases, lien, pied }) {
  return [titre, "", ...phrases.map(sansBalises), "", lien, "", sansBalises(pied)].join("\n");
}

// Les phrases portent un peu de gras ; la version texte n'en veut pas.
const sansBalises = (s) => String(s).replace(/<[^>]+>/g, "");

function modele(parties) {
  return {
    sujet: parties.sujet,
    texte: versionTexte(parties),
    html: gabarit(parties),
  };
}

const PIED_AUTOMATIQUE =
  "Message automatique envoyé par SEDAP'Tech. Si vous n'attendiez pas ce message, ignorez-le : " +
  "le lien expirera seul et personne ne peut s'en servir à votre place.";

// ------------------------------------------------------------- modèles

/** Nouvel administrateur : il choisit son mot de passe (lien de 24 h). */
function invitationAdmin({ prenom, lien }) {
  return modele({
    sujet: "Votre accès à l'espace administrateur SEDAP'Tech",
    titre: "Votre accès est prêt",
    phrases: [
      `Bonjour ${prenom},`,
      "Un compte administrateur vient d'être créé pour vous sur SEDAP'Tech. Il ne vous reste qu'à choisir votre mot de passe.",
      "<b>Ce lien est valable 24 heures</b> et ne sert qu'une fois.",
    ],
    lien,
    bouton: "Choisir mon mot de passe",
    pied: PIED_AUTOMATIQUE,
  });
}

/** Mot de passe oublié, côté administrateur (lien de 1 h). */
function motDePasseOublieAdmin({ prenom, lien }) {
  return modele({
    sujet: "Réinitialiser votre mot de passe SEDAP'Tech",
    titre: "Choisissez un nouveau mot de passe",
    phrases: [
      `Bonjour ${prenom},`,
      "Vous avez demandé à réinitialiser le mot de passe de votre compte administrateur.",
      "<b>Ce lien est valable 1 heure</b> et ne sert qu'une fois. Votre mot de passe actuel reste valable tant que vous n'en choisissez pas un nouveau.",
    ],
    lien,
    bouton: "Réinitialiser mon mot de passe",
    pied:
      "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : rien n'a changé sur votre compte. " +
      "Message automatique envoyé par SEDAP'Tech.",
  });
}

/**
 * Propriétaire : activation d'un compte neuf, ou nouveau code après un
 * oubli (lien de 7 jours). Écrire « votre espace est prêt » à quelqu'un qui
 * utilise l'appli depuis six mois lui ferait croire à une erreur.
 */
function activationProprietaire({ prenom, lien, raison = "nouveau" }) {
  if (raison === "pin") {
    return modele({
      sujet: "Votre nouveau code SEDAP'Tech",
      titre: "Choisissez votre nouveau code",
      phrases: [
        `Bonjour ${prenom},`,
        "Votre code à 4 chiffres a été réinitialisé à votre demande. Ouvrez le lien ci-dessous pour en choisir un nouveau.",
        "<b>Ce lien est valable 7 jours</b> et ne sert qu'une fois.",
      ],
      lien,
      bouton: "Choisir mon nouveau code",
      pied: PIED_AUTOMATIQUE,
    });
  }

  return modele({
    sujet: "Votre espace SEDAP'Tech est prêt",
    titre: "Bienvenue sur SEDAP'Tech",
    phrases: [
      `Bonjour ${prenom},`,
      "Votre espace propriétaire a été créé par SEDAP. Ouvrez le lien ci-dessous pour confirmer votre numéro et choisir votre code à 4 chiffres.",
      "Vous y suivrez vos bandes, vos dépenses et vos résultats, ferme par ferme.",
      "<b>Ce lien est valable 7 jours</b> et ne sert qu'une fois.",
    ],
    lien,
    bouton: "Activer mon espace",
    pied: PIED_AUTOMATIQUE,
  });
}

module.exports = { invitationAdmin, motDePasseOublieAdmin, activationProprietaire };
