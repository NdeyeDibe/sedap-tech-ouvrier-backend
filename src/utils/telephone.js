// Numéros de téléphone des clients (ventes).
//
// Règle SEDAP : numéro obligatoire, exactement 9 chiffres (format sénégalais,
// ex. 77 123 45 67). On le stocke toujours au format international +221.

const NB_CHIFFRES = 9;

// Garde uniquement les chiffres et retire un indicatif 221 éventuel,
// pour accepter "77 123 45 67", "771234567" ou "+221 77 123 45 67".
function normaliser(valeur) {
  let chiffres = String(valeur ?? "").replace(/\D/g, "");
  if (chiffres.length === NB_CHIFFRES + 3 && chiffres.startsWith("221")) {
    chiffres = chiffres.slice(3);
  }
  return chiffres;
}

function estValide(valeur) {
  return normaliser(valeur).length === NB_CHIFFRES;
}

function auFormatInternational(valeur) {
  return `+221${normaliser(valeur)}`;
}

module.exports = { NB_CHIFFRES, normaliser, estValide, auFormatInternational };
