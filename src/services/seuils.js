const pool = require("../db/pool");

// Seuils d'alerte — cahier admin, maquette 20.
//
// Le catalogue ci-dessous est la seule source de vérité : il décrit chaque
// seuil, sa valeur d'origine, ses bornes et l'unité affichée. La table
// `parametres` ne contient que ce que SEDAP a effectivement changé ; tout
// le reste vaut la valeur d'origine. « Revenir aux valeurs SEDAP » est donc
// un simple DELETE, sans avoir à réécrire les valeurs par défaut quelque
// part.
//
// Les bornes ne sont pas décoratives. Un taux de mortalité urgent réglé à
// 0 % rendrait toutes les bandes rouges en permanence ; à 100 %, plus
// aucune alerte ne partirait jamais. Dans les deux cas l'écran devient
// inutile sans que personne ne comprenne pourquoi.

const CATALOGUE = {
  // ------------------------------------------------------- mortalité
  mortalite_taux_urgent: {
    groupe: "Mortalité",
    libelle: "Taux de mortalité du jour",
    detail: "Morts du jour ÷ sujets vivants",
    type: "decimal",
    defaut: 0.5,
    min: 0.05,
    max: 20,
    prefixe: ">",
    unite: "%",
    niveau: "urgent",
  },
  mortalite_taux_surveiller: {
    groupe: "Mortalité",
    libelle: "Taux de mortalité du jour, après l'âge ci-dessous",
    detail: "Seuil orange",
    type: "decimal",
    defaut: 0.3,
    min: 0.01,
    max: 20,
    prefixe: ">",
    unite: "%",
    niveau: "surveiller",
  },
  mortalite_age_seuil_orange: {
    groupe: "Mortalité",
    libelle: "Âge à partir duquel le seuil orange s'applique",
    detail: "Jour de la bande",
    type: "entier",
    defaut: 7,
    min: 1,
    max: 60,
    prefixe: "J",
  },
  mortalite_facteur_veille: {
    groupe: "Mortalité",
    libelle: "Mortalité multipliée par rapport à la veille",
    detail: "Aujourd'hui ≥ N × hier",
    type: "decimal",
    defaut: 2,
    min: 1.1,
    max: 20,
    prefixe: "×",
    niveau: "surveiller",
  },
  mortalite_hausse_continue: {
    groupe: "Mortalité",
    libelle: "Hausse continue",
    detail: "Saisies consécutives en hausse",
    type: "entier",
    defaut: 4,
    min: 2,
    max: 10,
    unite: "saisies",
    niveau: "urgent",
  },

  // --------------------------------------------------- stock d'aliment
  aliment_autonomie_surveiller: {
    groupe: "Stock d'aliment",
    libelle: "Autonomie en aliment · orange",
    detail: "Stock restant ÷ distribué la veille",
    type: "entier",
    defaut: 5,
    min: 1,
    max: 60,
    prefixe: "≤",
    unite: "jours",
    niveau: "surveiller",
  },
  aliment_autonomie_urgent: {
    groupe: "Stock d'aliment",
    libelle: "Autonomie en aliment · rouge",
    type: "entier",
    defaut: 3,
    min: 0,
    max: 60,
    prefixe: "≤",
    unite: "jours",
    niveau: "urgent",
  },

  // -------------------------------------------------- saisies et pesage
  heure_controle_saisies: {
    groupe: "Saisies et pesage",
    libelle: "Heure de contrôle des saisies du jour",
    detail: "Heure de Dakar",
    type: "heure",
    defaut: "18:00",
    niveau: "surveiller",
  },
  // Ce réglage-ci s'affiche au bas du programme sanitaire (maquette 21),
  // pas dans l'onglet des seuils : c'est là qu'on le cherche.
  poids_min_reception_g: {
    ecran: "programme",
    groupe: "Réception",
    libelle: "Poids minimal à la réception des poussins",
    detail: "Contrôlé à la création de la bande par le responsable",
    type: "entier",
    defaut: 35,
    min: 10,
    max: 200,
    prefixe: "≥",
    unite: "g",
  },

  pesage_jours_signalement: {
    groupe: "Saisies et pesage",
    libelle: "Pesage oublié signalé pendant",
    detail: "Après le jour prévu",
    type: "entier",
    defaut: 2,
    min: 1,
    max: 30,
    unite: "jours",
    niveau: "surveiller",
  },
};

const DEFAUTS = Object.fromEntries(
  Object.entries(CATALOGUE).map(([cle, d]) => [cle, d.defaut])
);

// --------------------------------------------------------------- lecture

// Le cache existe parce que les alertes se calculent ligne par ligne, en
// synchrone : interroger la base à chaque bande multiplierait les requêtes
// par le nombre de poulaillers, pour des valeurs qui changent trois fois
// par an.
let cache = { valeurs: { ...DEFAUTS }, chargeLe: 0 };

const DUREE_CACHE = 60 * 1000;

/** Relit la base. Appelé au démarrage et après chaque modification. */
async function charger() {
  try {
    const { rows } = await pool.query("SELECT cle, valeur FROM parametres");
    const valeurs = { ...DEFAUTS };

    for (const { cle, valeur } of rows) {
      const description = CATALOGUE[cle];
      // Une clé inconnue est ignorée : elle vient d'une version plus
      // récente, ou d'un seuil retiré depuis. La rejeter bloquerait le
      // démarrage pour une ligne qui ne sert plus.
      if (!description) continue;
      const lue = convertir(description, valeur);
      if (lue !== null) valeurs[cle] = lue;
    }

    cache = { valeurs, chargeLe: Date.now() };
  } catch (erreur) {
    // Un échec de lecture ne doit pas priver le serveur de ses seuils : on
    // garde les derniers connus, ou les valeurs d'origine.
    console.error("Erreur chargement des seuils :", erreur.message);
    cache.chargeLe = Date.now();
  }
  return cache.valeurs;
}

/**
 * Les seuils en vigueur. Synchrone : les alertes en ont besoin à chaque
 * ligne. Au-delà d'une minute, une relecture part en arrière-plan — le
 * calcul en cours utilise les valeurs qu'il a, le suivant aura les neuves.
 */
function seuilsActuels() {
  if (Date.now() - cache.chargeLe > DUREE_CACHE) {
    cache.chargeLe = Date.now(); // évite d'en lancer dix d'affilée
    charger().catch(() => {});
  }
  return cache.valeurs;
}

function convertir(description, brute) {
  if (description.type === "heure") {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(brute) ? brute : null;
  }
  const n = Number(brute);
  if (!Number.isFinite(n)) return null;
  if (description.type === "entier" && !Number.isInteger(n)) return null;
  if (n < description.min || n > description.max) return null;
  return n;
}

// -------------------------------------------------------------- écriture

/**
 * Valide une valeur proposée. Renvoie { ok, valeur } ou { ok: false,
 * erreur } — le message est destiné à l'écran, pas aux logs.
 */
function valider(cle, brute) {
  const description = CATALOGUE[cle];
  if (!description) return { ok: false, erreur: `Seuil inconnu : ${cle}.` };

  if (description.type === "heure") {
    const texte = String(brute ?? "").trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(texte)) {
      return { ok: false, erreur: `${description.libelle} : heure attendue au format 18:00.` };
    }
    return { ok: true, valeur: texte };
  }

  const n = Number(String(brute ?? "").replace(",", "."));
  if (!Number.isFinite(n)) {
    return { ok: false, erreur: `${description.libelle} : nombre attendu.` };
  }
  if (description.type === "entier" && !Number.isInteger(n)) {
    return { ok: false, erreur: `${description.libelle} : nombre entier attendu.` };
  }
  if (n < description.min || n > description.max) {
    return {
      ok: false,
      erreur: `${description.libelle} : valeur attendue entre ${description.min} et ${description.max}.`,
    };
  }
  return { ok: true, valeur: n };
}

/**
 * Cohérence entre seuils : chacun peut être valable seul et l'ensemble
 * absurde. Un seuil orange plus haut que le rouge ne déclencherait jamais
 * d'orange, et personne ne verrait d'où vient le silence.
 */
function verifierEnsemble(valeurs) {
  if (valeurs.mortalite_taux_surveiller >= valeurs.mortalite_taux_urgent) {
    return "Le seuil orange de mortalité doit rester sous le seuil rouge.";
  }
  if (valeurs.aliment_autonomie_urgent >= valeurs.aliment_autonomie_surveiller) {
    return "L'autonomie rouge doit être plus courte que l'autonomie orange.";
  }
  return null;
}

module.exports = {
  CATALOGUE,
  DEFAUTS,
  charger,
  seuilsActuels,
  valider,
  verifierEnsemble,
};
