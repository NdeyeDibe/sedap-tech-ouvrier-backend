// Calculs financiers — sections IX à XI du cahier des charges.
//
// Côté serveur, comme les seuils d'alerte : le bilan d'une bande doit donner
// le même chiffre partout, et le propriétaire prend des décisions dessus.

const MOIS = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
];

// Un ouvrier pèse sur un mois s'il était en poste ce mois-là ET si son
// salaire a été fixé. Un compte créé par SEDAP sans montant ne coûte rien :
// le compter à zéro ou l'ignorer revient au même, mais l'ignorer rend le
// détail mensuel lisible.
function enPoste(personne, annee, mois) {
  if (!personne.salaire) return false;

  const debut = new Date(personne.prise_fonction);
  const commence =
    debut.getFullYear() < annee ||
    (debut.getFullYear() === annee && debut.getMonth() <= mois);
  if (!commence) return false;

  if (!personne.fin_fonction) return true;

  const fin = new Date(personne.fin_fonction);
  return (
    fin.getFullYear() > annee ||
    (fin.getFullYear() === annee && fin.getMonth() >= mois)
  );
}

function totalSalaires(personnel) {
  return personnel.reduce((t, p) => t + Number(p.salaire ?? 0), 0);
}

// Un frais se rattache au mois de sa date, pas au mois de sa saisie.
function fraisDuMois(frais, annee, mois) {
  return frais.filter((f) => {
    const d = new Date(f.date_depense);
    return d.getFullYear() === annee && d.getMonth() === mois;
  });
}

function totalFrais(frais) {
  return frais.reduce((t, f) => t + Number(f.montant), 0);
}

// Charges mois par mois, de janvier au mois demandé.
function chargesParMois(personnel, frais, annee, jusquAuMois) {
  return MOIS.slice(0, jusquAuMois + 1).map((nom, mois) => {
    const salaires = personnel
      .filter((p) => enPoste(p, annee, mois))
      .reduce((t, p) => t + Number(p.salaire), 0);

    const autres = totalFrais(fraisDuMois(frais, annee, mois));

    return { mois: mois + 1, nom, salaires, autres, total: salaires + autres };
  });
}

// bénéfice_net_réel = bénéfices bruts des bandes − salaires − autres charges
function resumeAnnuel({ bandes, personnel, frais, annee, jusquAuMois }) {
  const beneficesBruts = bandes.reduce((t, b) => t + Number(b.benefice_net), 0);

  const mensuel = chargesParMois(personnel, frais, annee, jusquAuMois);
  const salaires = mensuel.reduce((t, m) => t + m.salaires, 0);
  const autresCharges = mensuel.reduce((t, m) => t + m.autres, 0);

  return {
    beneficesBruts,
    salaires,
    autresCharges,
    beneficeNetReel: beneficesBruts - salaires - autresCharges,
    mensuel,
    nombreBandes: bandes.length,
  };
}

module.exports = {
  MOIS,
  enPoste,
  totalSalaires,
  fraisDuMois,
  totalFrais,
  chargesParMois,
  resumeAnnuel,
};
