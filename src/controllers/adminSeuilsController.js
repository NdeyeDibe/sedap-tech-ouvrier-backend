const pool = require("../db/pool");
const { parAdmin } = require("../services/journal");
const seuils = require("../services/seuils");

// Seuils d'alerte — cahier admin, maquette 20.
//
// Réservé à l'admin principal (routes marquées ★ dans l'annexe A) : ces
// valeurs gouvernent les trois interfaces à la fois, un réglage malheureux
// éteint les alertes de toutes les fermes en même temps.
//
// Chaque modification est journalisée avec l'ancienne et la nouvelle
// valeur. C'est ce qui permettra de répondre, dans six mois, à « pourquoi
// n'a-t-on pas été prévenus ? ».

// GET /api/admin/seuils
async function lireSeuils(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT p.cle, p.valeur, p.modifie_le,
              a.prenom AS admin_prenom, a.nom AS admin_nom
         FROM parametres p
         LEFT JOIN admins a ON a.id = p.modifie_par
        ORDER BY p.modifie_le DESC`
    );

    const valeurs = await seuils.charger();
    const derniere = rows[0];

    res.json({
      // Le catalogue part avec les valeurs : l'écran affiche libellés,
      // unités et bornes sans les redéfinir de son côté, où ils
      // divergeraient au premier changement.
      seuils: Object.entries(seuils.CATALOGUE).map(([cle, d]) => ({
        cle,
        groupe: d.groupe,
        libelle: d.libelle,
        detail: d.detail ?? null,
        type: d.type,
        prefixe: d.prefixe ?? null,
        unite: d.unite ?? null,
        niveau: d.niveau ?? null,
        min: d.min ?? null,
        max: d.max ?? null,
        defaut: d.defaut,
        valeur: valeurs[cle],
        // Ce qui a été changé par rapport à l'origine : l'écran peut le
        // signaler, et « Revenir aux valeurs SEDAP » sait quoi effacer.
        modifie: valeurs[cle] !== d.defaut,
      })),
      derniereModification: derniere
        ? {
            le: derniere.modifie_le,
            par:
              [derniere.admin_prenom, derniere.admin_nom].filter(Boolean).join(" ") || null,
          }
        : null,
    });
  } catch (erreur) {
    console.error("Erreur lecture des seuils :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// PATCH /api/admin/seuils — body : { cle: valeur, … }
async function modifierSeuils(req, res) {
  const propositions = req.body ?? {};
  const cles = Object.keys(propositions);

  if (cles.length === 0) {
    return res.status(400).json({ erreur: "Aucun seuil à modifier." });
  }

  // On valide TOUT avant d'écrire quoi que ce soit : enregistrer les trois
  // premiers seuils puis refuser le quatrième laisserait un jeu de valeurs
  // incohérent, et l'écran afficherait autre chose que la base.
  const valides = {};
  for (const cle of cles) {
    const resultat = seuils.valider(cle, propositions[cle]);
    if (!resultat.ok) return res.status(400).json({ erreur: resultat.erreur });
    valides[cle] = resultat.valeur;
  }

  const ensemble = { ...seuils.seuilsActuels(), ...valides };
  const incoherence = seuils.verifierEnsemble(ensemble);
  if (incoherence) return res.status(400).json({ erreur: incoherence });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const avant = { ...seuils.seuilsActuels() };

    for (const [cle, valeur] of Object.entries(valides)) {
      if (valeur === seuils.DEFAUTS[cle]) {
        // Revenu à la valeur d'origine : on efface la ligne plutôt que de
        // stocker « la valeur par défaut », pour que le jour où SEDAP
        // changera ses défauts, ce client les suive.
        await client.query("DELETE FROM parametres WHERE cle = $1", [cle]);
      } else {
        await client.query(
          `INSERT INTO parametres (cle, valeur, modifie_par)
                VALUES ($1, $2, $3)
           ON CONFLICT (cle) DO UPDATE
                  SET valeur = excluded.valeur,
                      modifie_le = now(),
                      modifie_par = excluded.modifie_par`,
          [cle, String(valeur), req.utilisateur.id]
        );
      }
    }

    await client.query("COMMIT");

    const apres = await seuils.charger();

    // Seuls les seuils réellement changés partent au journal : enregistrer
    // neuf lignes identiques à chaque clic rendrait l'historique illisible.
    const changes = Object.fromEntries(
      Object.keys(valides)
        .filter((cle) => avant[cle] !== apres[cle])
        .map((cle) => [cle, { avant: avant[cle], apres: apres[cle] }])
    );

    if (Object.keys(changes).length > 0) {
      parAdmin(req, {
        action: "seuils_modifies",
        cibleType: "parametres",
        details: changes,
      });
    }

    res.json({ seuils: apres, modifies: Object.keys(changes) });
  } catch (erreur) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Erreur modification des seuils :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

// DELETE /api/admin/seuils — « Revenir aux valeurs SEDAP » (maquette 20).
async function reinitialiserSeuils(req, res) {
  try {
    const avant = { ...seuils.seuilsActuels() };
    const { rowCount } = await pool.query("DELETE FROM parametres");
    const apres = await seuils.charger();

    if (rowCount > 0) {
      parAdmin(req, {
        action: "seuils_modifies",
        cibleType: "parametres",
        details: { reinitialisation: true, avant },
      });
    }

    res.json({ seuils: apres, reinitialises: rowCount });
  } catch (erreur) {
    console.error("Erreur réinitialisation des seuils :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = { lireSeuils, modifierSeuils, reinitialiserSeuils };
