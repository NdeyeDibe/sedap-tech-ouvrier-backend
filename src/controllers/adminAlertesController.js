const pool = require("../db/pool");
const { chargerToutesLesFermes, ouvrierDe, HEURE_LIMITE_SAISIE } = require("../services/alertesFerme");
const { parAdmin } = require("../services/journal");

// Alertes — cahier admin, maquettes 05 et 06.
//
// Les alertes ne vivent pas en base : elles se recalculent à chaque appel à
// partir de l'état réel des bandes. Ce qui se stocke, c'est ce que SEDAP en
// a fait — voir la migration 021.
//
// Deux règles tiennent tout l'écran, et elles sont écrites en clair sous le
// tableau (maquette 05) :
//
//  - « Traitée » et « Ignorée » ne changent que la liste de SEDAP. Le
//    propriétaire voit son alerte tant que la situation dure. Marquer une
//    alerte traitée, c'est dire « je m'en suis occupé », pas « c'est
//    réglé ».
//
//  - Une alerte qui s'aggrave revient « À traiter ». Sans cette règle, une
//    mortalité ignorée à « à surveiller » passerait « urgent » sans que
//    personne ne la revoie.

const GRAVITE = { surveiller: 1, urgent: 2 };

// Les types d'alerte, dans l'ordre du filtre « Tous les types ». Les
// libellés reprennent ceux des alertes elles-mêmes (utils/alertes.js).
const TYPES = [
  ["mortalite", "Mortalité"],
  ["aliment", "Stock aliment"],
  ["vaccination", "Vaccination"],
  ["pesage", "Pesage"],
  ["reception", "À chiffrer"],
  ["saisie", "Saisie du jour"],
];

const LIBELLE_TYPE = Object.fromEntries(TYPES);

// L'identité d'une alerte, la même que celle du suivi en base.
const identite = (bandeId, type, cle) => `${bandeId}:${type}:${cle}`;

// ------------------------------------------------------------ « depuis »

// Depuis quand l'alerte dure. Chaque type a sa propre réponse, et aucune
// n'est devinable : c'est la donnée qui a déclenché l'alerte qui la porte.
// Quand on ne peut pas le savoir, on renvoie null et l'écran affiche « — »
// plutôt qu'une durée inventée.
function depuisDeLAlerte(alerte, ligne, saisies) {
  const debut = ligne.date_debut ? new Date(ligne.date_debut) : null;

  // Le jour J d'une bande : J1 est le jour du démarrage.
  const jourDeLaBande = (jour) => {
    if (!debut || !jour) return null;
    const d = new Date(debut);
    d.setDate(d.getDate() + (jour - 1));
    return d.toISOString();
  };

  switch (alerte.type) {
    // La saisie de mortalité du jour est ce qui a déclenché l'alerte.
    case "mortalite":
      return saisies?.mortalite ?? null;

    // L'autonomie se calcule sur la dernière distribution d'aliment.
    case "aliment":
      return saisies?.alimentation ?? null;

    // La saisie manque depuis l'heure limite, pas depuis ce matin.
    case "saisie":
      return heureLimiteAujourdhui();

    case "vaccination":
      return jourDeLaBande(ligne.bande?.prochainVaccin?.jour);

    case "pesage":
      return jourDeLaBande(ligne.bande?.pesageManque?.jour);

    // Le plus ancien élément sans prix ; la vue le donne déjà.
    case "reception":
      return ligne.a_chiffrer_depuis ?? null;

    default:
      return null;
  }
}

// 18h00, heure de Dakar (UTC+0), aujourd'hui.
function heureLimiteAujourdhui() {
  const [h, m] = String(HEURE_LIMITE_SAISIE ?? "18:00").split(":").map(Number);
  const d = new Date();
  d.setUTCHours(h, m || 0, 0, 0);
  return d.toISOString();
}

// Les saisies du jour qui portent l'heure de déclenchement, par bande.
async function saisiesDuJour(bandeIds) {
  if (bandeIds.length === 0) return {};

  const { rows } = await pool.query(
    `SELECT b.id AS bande_id,
            (SELECT sm.cree_le FROM saisies_mortalite sm
              WHERE sm.bande_id = b.id AND sm.date_saisie = CURRENT_DATE) AS mortalite,
            (SELECT max(sa.cree_le) FROM saisies_alimentation sa
              WHERE sa.bande_id = b.id) AS alimentation
       FROM bandes b WHERE b.id = ANY($1)`,
    [bandeIds]
  );

  return Object.fromEntries(
    rows.map((r) => [r.bande_id, { mortalite: r.mortalite, alimentation: r.alimentation }])
  );
}

// --------------------------------------------------------------- le suivi

async function suivisParAlerte(bandeIds) {
  if (bandeIds.length === 0) return {};

  const { rows } = await pool.query(
    `SELECT s.bande_id, s.type, s.cle, s.niveau, s.etat, s.motif, s.cree_le,
            a.prenom AS admin_prenom, a.nom AS admin_nom
       FROM suivis_alertes s
       LEFT JOIN admins a ON a.id = s.admin_id
      WHERE s.bande_id = ANY($1)`,
    [bandeIds]
  );

  return Object.fromEntries(
    rows.map((r) => [identite(r.bande_id, r.type, r.cle), r])
  );
}

// L'état de suivi d'une alerte, aggravation comprise.
function etatDuSuivi(alerte, suivi) {
  if (!suivi) return { etat: "a_traiter" };

  // L'alerte s'est aggravée depuis la décision : elle redevient à traiter,
  // et on dit pourquoi elle est remontée.
  if (GRAVITE[alerte.niveau] > GRAVITE[suivi.niveau]) {
    return {
      etat: "a_traiter",
      revenue: true,
      ancienEtat: suivi.etat,
      ancienNiveau: suivi.niveau,
    };
  }

  return {
    etat: suivi.etat,
    motif: suivi.motif,
    le: suivi.cree_le,
    par: [suivi.admin_prenom, suivi.admin_nom].filter(Boolean).join(" ") || null,
  };
}

// --------------------------------------------------- GET /api/admin/alertes

async function listeAlertes(req, res) {
  try {
    const lignes = await chargerToutesLesFermes();
    const avecBande = lignes.filter((l) => l.bande_id && l.alertes.length > 0);
    const bandeIds = [...new Set(avecBande.map((l) => l.bande_id))];

    const [suivis, saisies] = await Promise.all([
      suivisParAlerte(bandeIds),
      saisiesDuJour(bandeIds),
    ]);

    const alertes = avecBande.flatMap((ligne) =>
      ligne.alertes.map((a) => ({
        id: identite(ligne.bande_id, a.type, a.cle),
        bandeId: ligne.bande_id,
        type: a.type,
        cle: a.cle,
        niveau: a.niveau,
        titre: a.titre,
        message: a.message,
        depuis: depuisDeLAlerte(a, ligne, saisies[ligne.bande_id]),
        ferme: { id: ligne.ferme_id, nom: ligne.ferme_nom },
        poulailler: { id: ligne.poulailler_id, nom: ligne.poulailler_nom },
        bande: { id: ligne.bande_id, numero: ligne.bande_numero },
        responsable: ouvrierDe(ligne),
        suivi: etatDuSuivi(a, suivis[identite(ligne.bande_id, a.type, a.cle)]),
      }))
    );

    // Tri de la maquette : par gravité, puis de la plus récente à la plus
    // ancienne. Une alerte sans date connue passe en dernier de son
    // niveau — elle ne doit pas s'intercaler au hasard.
    alertes.sort((x, y) => {
      const gravite = GRAVITE[y.niveau] - GRAVITE[x.niveau];
      if (gravite !== 0) return gravite;
      if (!x.depuis) return 1;
      if (!y.depuis) return -1;
      return new Date(y.depuis) - new Date(x.depuis);
    });

    const poulaillers = new Set(alertes.map((a) => a.poulailler.id));
    const fermes = new Map();
    for (const a of alertes) {
      fermes.set(a.ferme.id, {
        id: a.ferme.id,
        nom: a.ferme.nom,
        nombre: (fermes.get(a.ferme.id)?.nombre ?? 0) + 1,
      });
    }

    res.json({
      chiffres: {
        total: alertes.length,
        urgentes: alertes.filter((a) => a.niveau === "urgent").length,
        aSurveiller: alertes.filter((a) => a.niveau === "surveiller").length,
        aTraiter: alertes.filter((a) => a.suivi.etat === "a_traiter").length,
        poulaillers: poulaillers.size,
        fermes: fermes.size,
      },
      // Les listes des trois menus déroulants, avec leurs compteurs. Un type
      // qui n'a aucune alerte n'est pas proposé : un filtre qui ne peut rien
      // trouver n'est pas un filtre.
      types: TYPES.filter(([cle]) => alertes.some((a) => a.type === cle)).map(([cle, libelle]) => ({
        cle,
        libelle,
        nombre: alertes.filter((a) => a.type === cle).length,
      })),
      fermes: [...fermes.values()].sort((a, b) => a.nom.localeCompare(b.nom)),
      alertes,
    });
  } catch (erreur) {
    console.error("Erreur liste des alertes :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// ------------------------------------------- PATCH /api/admin/alertes/suivi

const texte = (v) => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};

async function marquerAlerte(req, res) {
  const bandeId = Number(req.body.bandeId);
  const type = texte(req.body.type);
  const cle = texte(req.body.cle);
  const etat = texte(req.body.etat);
  const motif = texte(req.body.motif);
  const niveau = texte(req.body.niveau);

  if (!Number.isInteger(bandeId) || !type || !cle) {
    return res.status(400).json({ erreur: "Alerte non identifiée." });
  }
  if (!["traitee", "ignoree", "a_traiter"].includes(etat)) {
    return res.status(400).json({ erreur: "État de suivi inconnu." });
  }
  if (etat === "ignoree" && !motif) {
    // Maquette 06 : on ne met pas une alerte de côté sans dire pourquoi.
    return res.status(400).json({ erreur: "Indiquez le motif." });
  }
  if (etat !== "a_traiter" && !["surveiller", "urgent"].includes(niveau)) {
    return res.status(400).json({ erreur: "Gravité de l'alerte manquante." });
  }

  try {
    if (etat === "a_traiter") {
      // Remettre à traiter, c'est effacer la décision : l'alerte redevient
      // ce qu'elle était avant qu'on y touche.
      const { rowCount } = await pool.query(
        "DELETE FROM suivis_alertes WHERE bande_id = $1 AND type = $2 AND cle = $3",
        [bandeId, type, cle]
      );
      if (rowCount > 0) journaliser(req, { bandeId, type, cle, etat });
      return res.json({ bandeId, type, cle, suivi: { etat: "a_traiter" } });
    }

    const { rows } = await pool.query(
      `INSERT INTO suivis_alertes (bande_id, type, cle, niveau, etat, motif, admin_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ON CONSTRAINT une_decision_par_alerte DO UPDATE
              SET niveau = excluded.niveau, etat = excluded.etat,
                  motif = excluded.motif, admin_id = excluded.admin_id,
                  cree_le = now()
         RETURNING cree_le`,
      [bandeId, type, cle, niveau, etat, motif, req.utilisateur.id]
    );

    journaliser(req, { bandeId, type, cle, etat, motif });

    res.json({
      bandeId,
      type,
      cle,
      suivi: {
        etat,
        motif,
        le: rows[0].cree_le,
        par: null, // l'écran recharge : il aura le nom avec le reste
      },
    });
  } catch (erreur) {
    if (erreur.code === "23503") {
      return res.status(404).json({ erreur: "Cette bande n'existe plus." });
    }
    console.error("Erreur suivi d'alerte :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// Le journal garde la trace : ignorer une alerte est une décision, et
// c'est elle qu'on relira si la situation tourne mal.
function journaliser(req, { bandeId, type, cle, etat, motif }) {
  parAdmin(req, {
    action: "alerte_suivie",
    cibleType: "alerte",
    bandeId,
    details: { type, cle, etat, ...(motif ? { motif } : {}) },
  });
}

module.exports = { listeAlertes, marquerAlerte, LIBELLE_TYPE };
