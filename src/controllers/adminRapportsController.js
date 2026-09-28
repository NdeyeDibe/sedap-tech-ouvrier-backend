const pool = require("../db/pool");
const { MOIS, enPoste, chargesParMois, totalFrais, fraisDuMois } = require("../utils/finances");
const { KG_PAR_SAC } = require("../utils/alertes");

// Rapports — cahier admin, section IX. Maquettes 15, 16 et 17.
//
// Règle qui commande tout le fichier : « mêmes chiffres que les bilans du
// propriétaire » (maquette 15). Un bénéfice qui diffère de deux cents
// francs entre l'écran de SEDAP et celui de son client est pire que pas de
// rapport du tout — c'est une discussion à avoir au téléphone, sans savoir
// qui a raison. D'où deux contraintes :
//
//  - le bénéfice d'une bande vient de `bilans_bandes`, jamais d'un calcul
//    refait ici ;
//  - les salaires et les frais passent par utils/finances.js, le même
//    module que l'écran Finances du propriétaire.
//
// Vocabulaire, repris des maquettes et à ne pas mélanger :
//  - « bénéfice des bandes » = recettes − dépenses, avant salaires et frais ;
//  - « bénéfice net réel »   = bénéfice des bandes − salaires − autres frais.

// Une bande compte dans un rapport quand elle est TERMINÉE, à la date de sa
// clôture. Une bande en cours n'a pas de bénéfice : ses poussins sont
// achetés, ses ventes pas encore faites — la compter donnerait un résultat
// faussement négatif tous les mois, puis faussement positif à la clôture.
const REQUETE_BANDES_TERMINEES = `
  SELECT bb.bande_id, bb.numero, bb.date_fin, bb.morts, bb.vendus,
         bb.taux_mortalite, bb.benefice_net, bb.sujets_sans_prix,
         effectif_initial(bb.bande_id) AS effectif_initial,
         pl.nom AS poulailler_nom,
         f.id AS ferme_id, f.nom AS ferme_nom,
         p.id AS proprietaire_id, p.prenom AS proprietaire_prenom,
         p.nom AS proprietaire_nom
    FROM bilans_bandes bb
    JOIN poulaillers pl ON pl.id = bb.poulailler_id
    JOIN fermes f ON f.id = pl.ferme_id
    JOIN proprietaires p ON p.id = f.proprietaire_id
   WHERE bb.statut = 'terminee'
     AND bb.date_fin >= $1 AND bb.date_fin < $2
     AND ($3::int IS NULL OR f.id = $3)
   ORDER BY bb.date_fin DESC
`;

// --------------------------------------------------------------- utilitaires

const nombre = (v) => Number(v ?? 0);

// Les bornes d'un mois et d'une année, en dates : la comparaison se fait
// sur date_fin, un timestamp. On prend [début, début du suivant[ plutôt
// qu'un BETWEEN, qui inclurait le 1er du mois suivant à 00h00.
function bornesAnnee(annee) {
  return [`${annee}-01-01`, `${annee + 1}-01-01`];
}

function bornesMois(annee, mois) {
  const suivant = mois === 12 ? [annee + 1, 1] : [annee, mois + 1];
  return [
    `${annee}-${String(mois).padStart(2, "0")}-01`,
    `${suivant[0]}-${String(suivant[1]).padStart(2, "0")}-01`,
  ];
}

// L'année et le mois demandés, ou ceux d'aujourd'hui. Une année farfelue
// (0, 9999, du texte) est ramenée à l'année en cours plutôt que refusée :
// un rapport est une consultation, pas une saisie.
function periodeDemandee(req) {
  const maintenant = new Date();
  const anneeBrute = Number(req.query.annee);
  const moisBrut = Number(req.query.mois);

  const annee =
    Number.isInteger(anneeBrute) && anneeBrute >= 2020 && anneeBrute <= 2100
      ? anneeBrute
      : maintenant.getFullYear();

  const mois =
    Number.isInteger(moisBrut) && moisBrut >= 1 && moisBrut <= 12
      ? moisBrut
      : maintenant.getMonth() + 1;

  return { annee, mois };
}

// « Toutes les fermes » est la valeur par défaut : null, pas 0.
function fermeDemandee(req) {
  const id = Number(req.query.ferme);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function grouperParFerme(bandes) {
  const fermes = new Map();

  for (const b of bandes) {
    if (!fermes.has(b.ferme_id)) {
      fermes.set(b.ferme_id, {
        id: b.ferme_id,
        nom: b.ferme_nom,
        proprietaire: {
          id: b.proprietaire_id,
          prenom: b.proprietaire_prenom,
          nom: b.proprietaire_nom,
        },
        bandesTerminees: 0,
        morts: 0,
        effectifInitial: 0,
        benefice: 0,
        derniereBande: null,
        // Le détail, pour que « toucher une ferme ouvre ses bandes et
        // leurs bilans » (maquette 15) n'oblige pas à un second appel.
        bandes: [],
      });
    }

    const f = fermes.get(b.ferme_id);
    f.bandesTerminees += 1;
    f.morts += nombre(b.morts);
    f.effectifInitial += nombre(b.effectif_initial);
    f.benefice += nombre(b.benefice_net);

    // Les bandes arrivent triées par date_fin décroissante : la première
    // vue pour une ferme est la plus récente.
    if (!f.derniereBande) {
      f.derniereBande = { id: b.bande_id, numero: b.numero, date: b.date_fin };
    }

    f.bandes.push({
      id: b.bande_id,
      numero: b.numero,
      poulailler: b.poulailler_nom,
      date: b.date_fin,
      benefice: nombre(b.benefice_net),
      tauxMortalite: nombre(b.taux_mortalite),
    });
  }

  return [...fermes.values()].map((f) => ({
    ...f,
    // Mortalité moyenne pondérée par l'effectif, pas moyenne des taux :
    // une bande de 200 sujets ne pèse pas autant qu'une de 4 000, et la
    // moyenne des pourcentages donnerait le contraire.
    tauxMortalite: f.effectifInitial > 0 ? arrondi((f.morts * 100) / f.effectifInitial) : 0,
  }));
}

const arrondi = (v) => Math.round(v * 10) / 10;

// -------------------------------------------------- GET /rapports/par-ferme

// Maquette 15. Une ligne par ferme, sur une année.
async function rapportParFerme(req, res) {
  const { annee } = periodeDemandee(req);
  const [debut, fin] = bornesAnnee(annee);

  try {
    const [bandes, actives, sansPrix] = await Promise.all([
      pool.query(REQUETE_BANDES_TERMINEES, [debut, fin, null]),
      pool.query("SELECT count(*) AS n FROM bandes WHERE statut <> 'terminee'"),
      // Les ramassages sans prix de TOUTES les bandes, pas seulement de
      // l'année : c'est une liste de choses à faire — des sujets sortis de
      // la ferme dont personne n'a encore dit à quel prix. Les limiter à
      // l'année cacherait les plus anciens, qui sont les plus urgents.
      pool.query("SELECT coalesce(sum(sujets_sans_prix), 0) AS n FROM recettes_bandes"),
    ]);

    const fermes = grouperParFerme(bandes.rows).sort((a, b) => b.benefice - a.benefice);

    res.json({
      annee,
      chiffres: {
        bandesTerminees: bandes.rows.length,
        fermes: fermes.length,
        beneficeDesBandes: fermes.reduce((t, f) => t + f.benefice, 0),
        bandesActives: nombre(actives.rows[0].n),
        sujetsSansPrix: nombre(sansPrix.rows[0].n),
      },
      fermes,
    });
  } catch (erreur) {
    console.error("Erreur rapport par ferme :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// ---------------------------------------------------- GET /rapports/mensuel

// Maquette 16. Un mois, toutes les fermes ou une seule.
async function rapportMensuel(req, res) {
  const { annee, mois } = periodeDemandee(req);
  const fermeId = fermeDemandee(req);
  const [debut, fin] = bornesMois(annee, mois);

  try {
    const [terminees, demarrees, mortalite, aliment, saisies, recettes, personnel, frais, aConfirmer] =
      await Promise.all([
        pool.query(REQUETE_BANDES_TERMINEES, [debut, fin, fermeId]),

        pool.query(
          `SELECT count(*) AS n
             FROM bandes b
             JOIN poulaillers pl ON pl.id = b.poulailler_id
            WHERE b.date_debut >= $1 AND b.date_debut < $2
              AND ($3::int IS NULL OR pl.ferme_id = $3)`,
          [debut, fin, fermeId]
        ),

        // Les morts DU MOIS, pas ceux des bandes terminées ce mois-ci :
        // une bande démarrée en juin et close en août a perdu des sujets
        // chaque mois, et chaque mois doit porter les siens.
        pool.query(
          `SELECT pl.ferme_id, coalesce(sum(sm.mortalite), 0) AS morts
             FROM saisies_mortalite sm
             JOIN bandes b ON b.id = sm.bande_id
             JOIN poulaillers pl ON pl.id = b.poulailler_id
            WHERE sm.date_saisie >= $1 AND sm.date_saisie < $2
              AND ($3::int IS NULL OR pl.ferme_id = $3)
            GROUP BY pl.ferme_id`,
          [debut, fin, fermeId]
        ),

        pool.query(
          `SELECT coalesce(sum(sa.sacs), 0) AS sacs,
                  coalesce(sum(sa.kg_supplementaires), 0) AS kg
             FROM saisies_alimentation sa
             JOIN bandes b ON b.id = sa.bande_id
             JOIN poulaillers pl ON pl.id = b.poulailler_id
            WHERE sa.date_saisie >= $1 AND sa.date_saisie < $2
              AND ($3::int IS NULL OR pl.ferme_id = $3)`,
          [debut, fin, fermeId]
        ),

        comptageSaisies(debut, fin, fermeId),

        // Les recettes ENCAISSÉES dans le mois, toutes bandes confondues —
        // à ne pas confondre avec le bénéfice des bandes closes ce mois-là.
        // Une vente d'août sur une bande close en septembre est un revenu
        // d'août.
        pool.query(
          `SELECT
             coalesce((SELECT sum(v.quantite * v.prix_unitaire)
                         FROM ventes v
                         JOIN bandes b ON b.id = v.bande_id
                         JOIN poulaillers pl ON pl.id = b.poulailler_id
                        WHERE v.type_vente = 'ferme'
                          AND v.date_vente >= $1 AND v.date_vente < $2
                          AND ($3::int IS NULL OR pl.ferme_id = $3)), 0)
           + coalesce((SELECT sum(d.quantite * d.prix_unitaire)
                         FROM ventes_details d
                         JOIN ventes v ON v.id = d.vente_id
                         JOIN bandes b ON b.id = v.bande_id
                         JOIN poulaillers pl ON pl.id = b.poulailler_id
                        WHERE d.cree_le >= $1 AND d.cree_le < $2
                          AND ($3::int IS NULL OR pl.ferme_id = $3)), 0)
             AS recettes`,
          [debut, fin, fermeId]
        ),

        pool.query(
          `SELECT pe.salaire, pe.prise_fonction, pe.fin_fonction
             FROM personnel pe
            WHERE ($1::int IS NULL OR pe.ferme_id = $1)`,
          [fermeId]
        ),

        pool.query(
          `SELECT f.montant, f.date_depense
             FROM frais f
            WHERE ($1::int IS NULL OR f.ferme_id = $1)`,
          [fermeId]
        ),

        ramassagesSansPrix(fermeId),
      ]);

    // La colonne « morts du mois » du tableau par ferme ne compte pas les
    // mêmes morts que la colonne « mortalité » d'un bilan de bande : une
    // bande close le 20 août apporte ses morts d'août, pas ceux de juillet.
    const mortsParFerme = new Map(mortalite.rows.map((l) => [l.ferme_id, nombre(l.morts)]));

    const fermes = grouperParFerme(terminees.rows)
      .map((f) => ({ ...f, mortsDuMois: mortsParFerme.get(f.id) ?? 0 }))
      .sort((a, b) => b.benefice - a.benefice);

    const beneficeDesBandes = fermes.reduce((t, f) => t + f.benefice, 0);

    const salaires = personnel.rows
      .filter((p) => enPoste(p, annee, mois - 1))
      .reduce((t, p) => t + nombre(p.salaire), 0);

    const autresFrais = totalFrais(fraisDuMois(frais.rows, annee, mois - 1));

    const morts = mortalite.rows.reduce((t, l) => t + nombre(l.morts), 0);
    const sacs = nombre(aliment.rows[0].sacs);
    const kilos = sacs * KG_PAR_SAC + nombre(aliment.rows[0].kg);

    res.json({
      annee,
      mois,
      moisNom: MOIS[mois - 1],
      fermeId,
      production: {
        bandesDemarrees: nombre(demarrees.rows[0].n),
        bandesTerminees: terminees.rows.length,
        morts,
        // Le taux rapporte les morts du mois à l'effectif des bandes en
        // vie pendant ce mois. Le rapporter au seul effectif des bandes
        // closes donnerait des pourcentages absurdes les mois sans clôture.
        tauxMortalite: saisies.effectifExpose > 0 ? arrondi((morts * 100) / saisies.effectifExpose) : 0,
        alimentSacs: sacs,
        alimentTonnes: Math.round(kilos / 100) / 10,
        saisiesFaites: saisies.faites,
        saisiesAttendues: saisies.attendues,
        tauxSaisies: saisies.attendues > 0 ? Math.round((saisies.faites * 100) / saisies.attendues) : 100,
      },
      resultat: {
        recettes: nombre(recettes.rows[0].recettes),
        beneficeDesBandes,
        salaires,
        autresFrais,
        beneficeNetReel: beneficeDesBandes - salaires - autresFrais,
      },
      aConfirmer,
      fermes,
    });
  } catch (erreur) {
    console.error("Erreur rapport mensuel :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// Saisies attendues : une par bande et par jour où elle était en vie dans
// le mois. Une bande démarrée le 20 n'en doit pas trente.
//
// Saisies faites : un jour compte dès qu'il porte une trace — mortalité,
// alimentation, santé, ou la déclaration « rien à signaler ». C'est la même
// règle que le bandeau « dernière saisie » du tableau de bord ; en changer
// ici donnerait deux chiffres différents pour la même journée.
async function comptageSaisies(debut, fin, fermeId) {
  const { rows } = await pool.query(
    `WITH bandes_du_mois AS (
       SELECT b.id,
              effectif_initial(b.id) AS effectif,
              greatest(b.date_debut::date, $1::date) AS premier,
              least(coalesce(b.date_fin::date, $2::date - 1), $2::date - 1) AS dernier
         FROM bandes b
         JOIN poulaillers pl ON pl.id = b.poulailler_id
        WHERE b.date_debut < $2
          AND (b.date_fin IS NULL OR b.date_fin >= $1)
          AND ($3::int IS NULL OR pl.ferme_id = $3)
     )
     SELECT
       coalesce(sum(greatest(dernier - premier + 1, 0)), 0) AS attendues,
       coalesce(sum(effectif), 0) AS effectif_expose,
       coalesce((SELECT count(*) FROM (
          SELECT DISTINCT bande_id, date_saisie FROM (
            SELECT bande_id, date_saisie FROM saisies_mortalite
            UNION ALL SELECT bande_id, date_saisie FROM saisies_alimentation
            UNION ALL SELECT bande_id, date_saisie FROM saisies_sante
            UNION ALL SELECT bande_id, date_saisie FROM saisies_sans_donnee
          ) toutes
          WHERE date_saisie >= $1 AND date_saisie < $2
            AND bande_id IN (SELECT id FROM bandes_du_mois)
       ) jours), 0) AS faites
     FROM bandes_du_mois`,
    [debut, fin, fermeId]
  );

  const l = rows[0] ?? {};
  return {
    attendues: nombre(l.attendues),
    faites: nombre(l.faites),
    effectifExpose: nombre(l.effectif_expose),
  };
}

// Le bandeau « Prix à confirmer » de la maquette 16 : des sujets sont
// sortis de la ferme, mais personne n'a encore dit à quel prix. Ils ne
// comptent pas dans les recettes, et il faut le dire — sinon le rapport
// paraît simplement mauvais.
async function ramassagesSansPrix(fermeId) {
  const { rows } = await pool.query(
    `SELECT v.id, v.date_vente, b.numero AS bande_numero, b.id AS bande_id,
            f.nom AS ferme_nom,
            coalesce(o.prenom || ' ' || o.nom, 'un ouvrier') AS par,
            v.quantite - coalesce((SELECT sum(d.quantite) FROM ventes_details d
                                    WHERE d.vente_id = v.id), 0) AS sujets
       FROM ventes v
       JOIN bandes b ON b.id = v.bande_id
       JOIN poulaillers pl ON pl.id = b.poulailler_id
       JOIN fermes f ON f.id = pl.ferme_id
       LEFT JOIN ouvriers o ON o.id = v.auteur_ouvrier_id
      WHERE v.type_vente = 'ramassage'
        AND ($1::int IS NULL OR f.id = $1)
      ORDER BY v.date_vente DESC`,
    [fermeId]
  );

  const lignes = rows
    .filter((l) => nombre(l.sujets) > 0)
    .map((l) => ({
      venteId: l.id,
      bandeId: l.bande_id,
      bandeNumero: l.bande_numero,
      ferme: l.ferme_nom,
      par: l.par,
      sujets: nombre(l.sujets),
      date: l.date_vente,
    }));

  return { sujets: lignes.reduce((t, l) => t + l.sujets, 0), lignes };
}

// ----------------------------------------------------- GET /rapports/annuel

// Maquette 17. Une année, comparée à une autre sur la même période.
//
// « Même période » est le point délicat : en septembre, comparer douze mois
// de 2025 à neuf mois de 2026 ferait croire à un effondrement. On arrête
// donc l'année de comparaison au même mois.
async function rapportAnnuel(req, res) {
  const { annee } = periodeDemandee(req);
  const fermeId = fermeDemandee(req);

  const comparaisonBrute = Number(req.query.comparer);
  const comparer =
    Number.isInteger(comparaisonBrute) && comparaisonBrute >= 2020 && comparaisonBrute < annee
      ? comparaisonBrute
      : null;

  const maintenant = new Date();
  // Pour une année passée, on va jusqu'à décembre ; pour l'année en cours,
  // jusqu'au mois d'aujourd'hui.
  const jusquAuMois = annee < maintenant.getFullYear() ? 11 : maintenant.getMonth();

  try {
    const [exercice, precedent, fermes] = await Promise.all([
      exerciceAnnuel(annee, jusquAuMois, fermeId),
      comparer ? exerciceAnnuel(comparer, jusquAuMois, fermeId) : Promise.resolve(null),
      pool.query(
        `SELECT count(*) FILTER (WHERE p.suspendu_le IS NULL) AS actives,
                count(*) FILTER (WHERE p.suspendu_le IS NOT NULL) AS suspendues
           FROM fermes f
           JOIN proprietaires p ON p.id = f.proprietaire_id`
      ),
    ]);

    res.json({
      annee,
      comparer,
      jusquAuMois: jusquAuMois + 1,
      moisNom: MOIS[jusquAuMois],
      fermeId,
      exercice,
      precedent,
      fermesActives: nombre(fermes.rows[0].actives),
      fermesSuspendues: nombre(fermes.rows[0].suspendues),
    });
  } catch (erreur) {
    console.error("Erreur rapport annuel :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// Un exercice : les bandes closes dans la période, les charges mois par
// mois, et le bénéfice net réel qui en découle. Même formule que l'écran
// Finances du propriétaire — c'est utils/finances.js qui la porte.
async function exerciceAnnuel(annee, jusquAuMois, fermeId) {
  const debut = `${annee}-01-01`;
  const fin =
    jusquAuMois === 11
      ? `${annee + 1}-01-01`
      : `${annee}-${String(jusquAuMois + 2).padStart(2, "0")}-01`;

  const [bandes, personnel, frais] = await Promise.all([
    pool.query(REQUETE_BANDES_TERMINEES, [debut, fin, fermeId]),
    pool.query(
      "SELECT salaire, prise_fonction, fin_fonction FROM personnel WHERE ($1::int IS NULL OR ferme_id = $1)",
      [fermeId]
    ),
    pool.query(
      "SELECT montant, date_depense FROM frais WHERE ($1::int IS NULL OR ferme_id = $1)",
      [fermeId]
    ),
  ]);

  const parFerme = grouperParFerme(bandes.rows).sort((a, b) => b.benefice - a.benefice);
  const beneficeDesBandes = parFerme.reduce((t, f) => t + f.benefice, 0);

  const mensuel = chargesParMois(personnel.rows, frais.rows, annee, jusquAuMois);
  const salaires = mensuel.reduce((t, m) => t + m.salaires, 0);
  const autresFrais = mensuel.reduce((t, m) => t + m.autres, 0);

  return {
    annee,
    bandesTerminees: bandes.rows.length,
    beneficeDesBandes,
    salaires,
    autresFrais,
    beneficeNetReel: beneficeDesBandes - salaires - autresFrais,
    // Le mois en cours est marqué : ses charges sont complètes mais ses
    // bandes, non — elles se clôtureront plus tard dans le mois.
    mensuel: mensuel.map((m) => ({
      ...m,
      enCours: annee === new Date().getFullYear() && m.mois === new Date().getMonth() + 1,
    })),
    fermes: parFerme,
  };
}

module.exports = { rapportParFerme, rapportMensuel, rapportAnnuel };
