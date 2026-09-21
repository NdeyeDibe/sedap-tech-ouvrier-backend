const crypto = require("crypto");

// Mots de passe des comptes admin — cahier admin v1.1, section III.
// L'ouvrier et le propriétaire ont un PIN ; seul l'admin a un mot de passe.

// 8 caractères au minimum, une majuscule, un chiffre, un caractère spécial.
// Renvoie le premier manquement, pour que l'écran puisse l'afficher tel quel.
function motDePasseFaible(valeur) {
  if (!valeur || valeur.length < 8) return "8 caractères minimum.";
  if (!/[A-Z]/.test(valeur)) return "Il faut au moins une majuscule.";
  if (!/[0-9]/.test(valeur)) return "Il faut au moins un chiffre.";
  if (!/[^A-Za-z0-9]/.test(valeur)) return "Il faut au moins un caractère spécial.";
  return null;
}

// Jeton d'un lien à usage unique (mot de passe oublié, premier mot de passe).
//
// Le lien porte le jeton en clair ; la base n'en garde que l'empreinte. Une
// fuite de la table admins ne donne donc aucun lien utilisable — à la
// différence d'un jeton stocké tel quel.
function nouveauJeton() {
  const jeton = crypto.randomBytes(32).toString("hex");
  return { jeton, empreinte: empreinteJeton(jeton) };
}

function empreinteJeton(jeton) {
  return crypto.createHash("sha256").update(String(jeton)).digest("hex");
}

module.exports = { motDePasseFaible, nouveauJeton, empreinteJeton };
