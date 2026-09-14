// Seuils d'alerte — section VIII du cahier des charges.
//
// Ces règles vivaient côté front. Elles remontent ici parce que trois
// interfaces les consultent : si chacune les recalculait, rien ne garantirait
// qu'un même poulailler soit « urgent » partout au même moment.

const NIVEAU = { OK: "ok", SURVEILLER: "surveiller", URGENT: "urgent" };

const GRAVITE = [NIVEAU.OK, NIVEAU.SURVEILLER, NIVEAU.URGENT];

function niveauLePlusGrave(niveaux) {
  return niveaux.reduce(
    (pire, n) => (GRAVITE.indexOf(n) > GRAVITE.indexOf(pire) ? n : pire),
    NIVEAU.OK
  );
}

// Un sac d'aliment pèse 50 kg. Les saisies de l'ouvrier mêlent des sacs et
// des kilos d'appoint ; l'alerte raisonne en kilos, d'où la conversion.
// À déplacer en paramètre si un fournisseur livre d'autres formats.
const KG_PAR_SAC = 50;

function kgDistribues({ sacs, kg_supplementaires }) {
  return Number(sacs || 0) * KG_PAR_SAC + Number(kg_supplementaires || 0);
}

function alerteMortalite({
  mortsDuJour,
  sujetsVivants,
  ageJours,
  mortsJoursPrecedents = [],
  etatOuvrier = "bien",
}) {
  if (!sujetsVivants) return NIVEAU.OK;

  const taux = (mortsDuJour / sujetsVivants) * 100;
  const [veille, avantVeille, troisiemeJour] = mortsJoursPrecedents;

  if (etatOuvrier === "urgent") return NIVEAU.URGENT;
  if (taux > 0.5) return NIVEAU.URGENT;

  const hausseContinue =
    veille != null &&
    avantVeille != null &&
    troisiemeJour != null &&
    mortsDuJour > veille &&
    veille > avantVeille &&
    avantVeille > troisiemeJour;
  if (hausseContinue) return NIVEAU.URGENT;

  if (veille != null && veille > 0 && mortsDuJour >= veille * 2) {
    return NIVEAU.SURVEILLER;
  }

  if (ageJours > 7 && taux > 0.3) return NIVEAU.SURVEILLER;

  return NIVEAU.OK;
}

// ratio = stock restant (kg) / quantité distribuée la veille (kg)
function alerteAliment({ stockRestantKg, distribueVeilleKg }) {
  if (!distribueVeilleKg) return NIVEAU.OK;

  const ratio = stockRestantKg / distribueVeilleKg;
  if (ratio <= 3) return NIVEAU.URGENT;
  if (ratio <= 5) return NIVEAU.SURVEILLER;
  return NIVEAU.OK;
}

function joursAutonomie({ stockRestantKg, distribueVeilleKg }) {
  if (!distribueVeilleKg) return null;
  return Math.floor(stockRestantKg / distribueVeilleKg);
}

// Vaccin prévu et non confirmé à la date prévue. Aucune alerte si le vaccin
// a été administré à temps, ni si sa date n'est pas encore arrivée.
function alerteVaccination({ datePrevue, confirme, aujourdhui = new Date() }) {
  if (confirme) return NIVEAU.OK;
  return new Date(datePrevue) <= aujourdhui ? NIVEAU.URGENT : NIVEAU.OK;
}

// Alertes actives d'une bande, de la plus grave à la plus calme.
function alertesBande(bande) {
  const alertes = [];

  const mortalite = alerteMortalite(bande);
  if (mortalite !== NIVEAU.OK) {
    alertes.push({
      type: "mortalite",
      niveau: mortalite,
      titre: "Mortalité",
      message: "Mortalité au dessus du seuil",
    });
  }

  const aliment = alerteAliment(bande);
  if (aliment !== NIVEAU.OK) {
    alertes.push({
      type: "aliment",
      niveau: aliment,
      titre: "Stock aliment",
      message: `Aliment : moins de ${joursAutonomie(bande) + 1} jours d'autonomie`,
    });
  }

  if (bande.prochainVaccin) {
    const vaccination = alerteVaccination(bande.prochainVaccin);
    if (vaccination !== NIVEAU.OK) {
      alertes.push({
        type: "vaccination",
        niveau: vaccination,
        titre: "Vaccination",
        message: `${bande.prochainVaccin.nom} non confirmé à J${bande.prochainVaccin.jour}`,
      });
    }
  }

  return alertes.sort(
    (a, b) => GRAVITE.indexOf(b.niveau) - GRAVITE.indexOf(a.niveau)
  );
}

function statutBande(bande) {
  return niveauLePlusGrave(alertesBande(bande).map((a) => a.niveau));
}

module.exports = {
  NIVEAU,
  KG_PAR_SAC,
  kgDistribues,
  niveauLePlusGrave,
  alerteMortalite,
  alerteAliment,
  alerteVaccination,
  joursAutonomie,
  alertesBande,
  statutBande,
};
