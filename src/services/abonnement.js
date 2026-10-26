// L'offre commerciale SEDAP'Tech, en un seul endroit.
//
// Trois packs, un nom chacun — le nom wolof EST le nom du pack, et la
// promesse n'est qu'un sous-titre (fiche d'offre v2, oct. 2026). Ne pas
// réintroduire « Suivi / Sérénité / Rentabilité » comme noms : la fiche
// en donnait deux par pack et personne ne savait plus lequel était le bon.
//
// Ce fichier répond à deux questions, et c'est le seul endroit où elles
// se décident : cette ferme est-elle encore dans ses 4 mois gratuits, et
// combien coûte la bande qu'elle ouvre aujourd'hui ?

const PACKS = [
  {
    code: "xam",
    nom: "XAM",
    promesse: "Je sais ce qui se passe dans mon poulailler.",
  },
  {
    code: "jamm",
    nom: "JAMM",
    promesse: "Je suis conseillé, je réduis mes pertes.",
  },
  {
    code: "jarin",
    nom: "JARIN",
    promesse: "Je produis mieux, je vends mieux.",
  },
];

const CODES = PACKS.map((p) => p.code);

// « 4 premiers mois gratuits pour tous les nouveaux inscrits, avec le
// pack XAM complet. »
const MOIS_GRATUITS = 4;

// « Toute ferme qui ouvre un compte entre le lancement et le 31 décembre
// 2026 ». Une ferme qui ouvre après cette date paie dès sa première bande.
const DERNIER_JOUR_OFFRE_LANCEMENT = "2026-12-31";

const deuxChiffres = (n) => String(n).padStart(2, "0");

/**
 * Une date en « AAAA-MM-JJ », sans heure ni fuseau.
 *
 * Les colonnes `date` de Postgres reviennent en objet Date à minuit
 * LOCAL : on relit donc les composantes locales. Passer par toISOString()
 * décalerait la date d'un jour pour tout fuseau à l'ouest de Greenwich.
 */
function versJour(valeur) {
  if (!valeur) return null;
  if (typeof valeur === "string") return valeur.slice(0, 10);
  const d = valeur instanceof Date ? valeur : new Date(valeur);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${deuxChiffres(d.getMonth() + 1)}-${deuxChiffres(d.getDate())}`;
}

/** Le jour d'aujourd'hui, au même format. */
const aujourdhui = () => versJour(new Date());

/**
 * Ajoute des mois à un jour, en restant dans le mois d'arrivée.
 *
 * 31 octobre + 4 mois donne le 28 (ou 29) février, pas le 3 mars : un
 * éleveur inscrit le 31 ne doit pas gagner trois jours gratuits de plus
 * que son voisin inscrit le 30.
 */
function ajouterMois(jour, mois) {
  const [a, m, j] = jour.split("-").map(Number);
  const cible = new Date(a, m - 1 + mois, 1);
  const dernierDuMois = new Date(cible.getFullYear(), cible.getMonth() + 1, 0).getDate();
  cible.setDate(Math.min(j, dernierDuMois));
  return versJour(cible);
}

/** Nombre de jours entre deux jours (b - a), négatif si b précède a. */
function ecartEnJours(a, b) {
  const [aa, am, aj] = a.split("-").map(Number);
  const [ba, bm, bj] = b.split("-").map(Number);
  const MS = 24 * 60 * 60 * 1000;
  return Math.round((Date.UTC(ba, bm - 1, bj) - Date.UTC(aa, am - 1, aj)) / MS);
}

/** Un jour valide écrit « AAAA-MM-JJ », ou null. */
function jourValide(valeur) {
  const texte = String(valeur ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texte)) return null;
  const [a, m, j] = texte.split("-").map(Number);
  const d = new Date(a, m - 1, j);
  // Rejette le 31 février, que Date transformerait en 3 mars.
  if (d.getFullYear() !== a || d.getMonth() !== m - 1 || d.getDate() !== j) return null;
  return texte;
}

const trouverPack = (code) =>
  PACKS.find((p) => p.code === String(code ?? "").trim().toLowerCase()) ?? null;

/**
 * Où en est l'abonnement d'une ferme ?
 *
 * Reçoit la ligne `fermes` (pack, abonnement_debut) et ne lit rien en
 * base : l'appelant a déjà les deux colonnes.
 */
function etatAbonnement({ pack, abonnement_debut: debutBrut } = {}) {
  const p = trouverPack(pack);
  const debut = versJour(debutBrut);

  const etat = {
    pack: p?.code ?? null,
    packNom: p?.nom ?? null,
    promesse: p?.promesse ?? null,
    debut,
    // Ce qui manque pour facturer cette ferme. L'admin l'affiche tel quel.
    aRenseigner: [!p && "pack", !debut && "date d'ouverture"].filter(Boolean),
    eligibleOffreLancement: false,
    dernierJourGratuit: null,
    enPeriodeGratuite: false,
    joursGratuitsRestants: null,
  };

  if (!debut) return etat;

  // L'offre de lancement se juge sur la date d'ouverture, pas sur
  // aujourd'hui : une ferme ouverte en décembre 2026 garde ses 4 mois
  // gratuits jusqu'en avril 2027.
  etat.eligibleOffreLancement = ecartEnJours(debut, DERNIER_JOUR_OFFRE_LANCEMENT) >= 0;
  if (!etat.eligibleOffreLancement) return etat;

  // 4 mois gratuits : le dernier jour gratuit est la veille du même
  // quantième, quatre mois plus tard.
  const [pa, pm, pj] = ajouterMois(debut, MOIS_GRATUITS).split("-").map(Number);
  const veille = new Date(pa, pm - 1, pj);
  veille.setDate(veille.getDate() - 1);
  etat.dernierJourGratuit = versJour(veille);

  const restant = ecartEnJours(aujourdhui(), etat.dernierJourGratuit);
  etat.enPeriodeGratuite = restant >= 0;
  etat.joursGratuitsRestants = etat.enPeriodeGratuite ? restant : 0;

  return etat;
}

// ------------------------------------------------------- grille tarifaire
//
// Fiche d'offre v2, « 4. Les tarifs par bande ». Une bande se facture
// d'après le nombre de sujets qu'elle démarre et le pack de la ferme.
//
// JARIN se lit sur deux colonnes : les 10 premières bandes facturées
// comprennent la caméra solaire ; à partir de la 11e, elle appartient à
// l'éleveur et le prix baisse de 15 000 F.
//
// `null` ne veut pas dire « gratuit » : il veut dire que la grille ne
// répond pas, et personne n'invente un prix à sa place.
//  - au-delà de 12 000 sujets, l'offre dit « sur devis » ;
//  - les cases vides de la grille (JAMM sous 500 sujets, JARIN sous
//    1 500) ne sont pas commercialisées — « jusqu'à 500 sujets, XAM est
//    le seul pack proposé ». Si ça arrive quand même, l'admin fixe le
//    montant à la main plutôt que de facturer un chiffre inventé.
const BANDES_AVEC_CAMERA = 10;

const TRANCHES = [
  { max: 500, libelle: "jusqu'à 500 sujets", xam: 5000, jamm: null, jarinAvec: null, jarinApres: null },
  { max: 1500, libelle: "501 à 1 500", xam: 10000, jamm: 15000, jarinAvec: null, jarinApres: null },
  { max: 3000, libelle: "1 501 à 3 000", xam: 15000, jamm: 22500, jarinAvec: 57500, jarinApres: 42500 },
  { max: 7000, libelle: "3 001 à 7 000", xam: 20000, jamm: 30000, jarinAvec: 65000, jarinApres: 50000 },
  { max: 12000, libelle: "7 001 à 12 000", xam: 25000, jamm: 37500, jarinAvec: 72500, jarinApres: 57500 },
  { max: Infinity, libelle: "plus de 12 000", xam: null, jamm: null, jarinAvec: null, jarinApres: null },
];

/**
 * Ce que coûte une bande.
 *
 * @param pack     code du pack de la ferme
 * @param effectif sujets vivants au démarrage (reçus moins morts à
 *                 l'arrivée) : c'est ce que la ferme élève réellement,
 *                 et ce que l'application affiche partout comme effectif.
 * @param rang     combien de bandes cette ferme a déjà fait facturer,
 *                 plus un. Ne sert qu'à JARIN, pour la caméra.
 */
function tarifPourBande({ pack, effectif, rang = 1 } = {}) {
  const p = trouverPack(pack);
  const sujets = Number(effectif);

  const resultat = {
    pack: p?.code ?? null,
    effectif: Number.isFinite(sujets) ? sujets : null,
    rang,
    tranche: null,
    montant: null,
    // Pourquoi il n'y a pas de montant, quand il n'y en a pas. L'admin
    // affiche ce motif tel quel : « sur devis » et « hors grille » ne se
    // traitent pas de la même façon.
    motif: null,
    cameraComprise: false,
  };

  if (!p) {
    resultat.motif = "pack non renseigné";
    return resultat;
  }
  if (!Number.isFinite(sujets) || sujets <= 0) {
    resultat.motif = "effectif inconnu";
    return resultat;
  }

  const tranche = TRANCHES.find((t) => sujets <= t.max);
  resultat.tranche = tranche.libelle;

  if (tranche.max === Infinity) {
    resultat.motif = "sur devis";
    return resultat;
  }

  if (p.code === "jarin") {
    resultat.cameraComprise = rang <= BANDES_AVEC_CAMERA;
    resultat.montant = resultat.cameraComprise ? tranche.jarinAvec : tranche.jarinApres;
  } else {
    resultat.montant = tranche[p.code];
  }

  if (resultat.montant == null) {
    resultat.cameraComprise = false;
    resultat.motif = `le pack ${p.nom} n'est pas proposé pour cette taille de bande`;
  }

  return resultat;
}

module.exports = {
  PACKS,
  CODES,
  TRANCHES,
  BANDES_AVEC_CAMERA,
  tarifPourBande,
  MOIS_GRATUITS,
  DERNIER_JOUR_OFFRE_LANCEMENT,
  trouverPack,
  jourValide,
  versJour,
  ajouterMois,
  ecartEnJours,
  etatAbonnement,
};
