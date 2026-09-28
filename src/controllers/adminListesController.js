const pool = require("../db/pool");
const { parAdmin } = require("../services/journal");

// Listes de référence — cahier admin, maquette 22.
//
// Couvoirs, souches et fournisseurs d'aliment vivaient en dur dans le front
// de l'ouvrier : ajouter un couvoir demandait un déploiement.
//
// Règle qui commande l'écran : UNE VALEUR DÉJÀ UTILISÉE NE SE SUPPRIME PAS.
// Effacer « Zalar » ne ferait pas disparaître les bandes qui en viennent :
// elles afficheraient une provenance orpheline, et les rapports par couvoir
// deviendraient faux. On masque à la place — la valeur quitte les listes de
// saisie, l'historique garde son sens.

const LISTES = {
  couvoir: "Couvoirs",
  souche: "Souches",
  fournisseur_aliment: "Fournisseurs d'aliment",
};

const texte = (v) => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};

// Où chaque liste est employée. Sert à savoir si une valeur est utilisée,
// donc si elle peut encore être supprimée.
const USAGES = {
  couvoir: [
    { table: "bandes", colonne: "provenance" },
    { table: "stock_receptions", colonne: "provenance" },
  ],
  souche: [{ table: "bandes", colonne: "souche" }],
  fournisseur_aliment: [{ table: "stock_receptions", colonne: "provenance" }],
};

async function compterUsages(liste, valeur) {
  let total = 0;
  for (const { table, colonne } of USAGES[liste] ?? []) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${colonne} = $1`,
      [valeur]
    );
    total += rows[0].n;
  }
  return total;
}

// GET /api/admin/listes
async function lireListes(req, res) {
  try {
    const { rows } = await pool.query(
      "SELECT id, liste, valeur, masque, ordre FROM listes_reference ORDER BY liste, ordre, valeur"
    );

    // Les usages sont comptés pour toutes les valeurs d'un coup : l'écran
    // doit savoir, avant le clic, si une valeur peut être supprimée ou
    // seulement masquée.
    const utilises = {};
    for (const ligne of rows) {
      utilises[ligne.id] = await compterUsages(ligne.liste, ligne.valeur);
    }

    res.json({
      listes: Object.entries(LISTES).map(([cle, titre]) => ({
        cle,
        titre,
        valeurs: rows
          .filter((r) => r.liste === cle)
          .map((r) => ({
            id: r.id,
            valeur: r.valeur,
            masque: r.masque,
            utilisee: utilises[r.id] > 0,
            usages: utilises[r.id],
          })),
      })),
    });
  } catch (erreur) {
    console.error("Erreur lecture des listes :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// GET /api/listes — lecture publique pour les applis ouvrier et
// propriétaire. Seules les valeurs non masquées y figurent : c'est tout
// l'intérêt du masquage.
async function listesPubliques(req, res) {
  try {
    const { rows } = await pool.query(
      "SELECT liste, valeur FROM listes_reference WHERE NOT masque ORDER BY liste, ordre, valeur"
    );

    const sortie = Object.fromEntries(Object.keys(LISTES).map((cle) => [cle, []]));
    for (const r of rows) sortie[r.liste]?.push(r.valeur);

    res.json(sortie);
  } catch (erreur) {
    console.error("Erreur lecture des listes publiques :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// POST /api/admin/listes
async function ajouterValeur(req, res) {
  const liste = texte(req.body.liste);
  const valeur = texte(req.body.valeur);

  if (!LISTES[liste]) return res.status(400).json({ erreur: "Liste inconnue." });
  if (!valeur) return res.status(400).json({ erreur: "Indiquez la valeur à ajouter." });

  try {
    const { rows } = await pool.query(
      `INSERT INTO listes_reference (liste, valeur, ordre)
            VALUES ($1, $2, (SELECT coalesce(max(ordre), 0) + 1
                               FROM listes_reference WHERE liste = $1 AND ordre < 99))
         RETURNING id, valeur, masque`,
      [liste, valeur]
    );

    parAdmin(req, {
      action: "liste_modifiee",
      cibleType: "liste",
      cibleId: rows[0].id,
      details: { liste, ajout: valeur },
    });

    res.status(201).json({ valeur: { ...rows[0], utilisee: false, usages: 0 } });
  } catch (erreur) {
    if (erreur.code === "23505") {
      return res.status(409).json({ erreur: "Cette valeur existe déjà dans la liste." });
    }
    console.error("Erreur ajout de valeur :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// PATCH /api/admin/listes/:id — renommer et/ou masquer.
async function modifierValeur(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erreur: "Identifiant invalide." });

  const valeur = req.body.valeur === undefined ? undefined : texte(req.body.valeur);
  const masque = typeof req.body.masque === "boolean" ? req.body.masque : undefined;

  if (valeur === null) return res.status(400).json({ erreur: "La valeur ne peut pas être vide." });
  if (valeur === undefined && masque === undefined) {
    return res.status(400).json({ erreur: "Rien à modifier." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: avant } = await client.query(
      "SELECT liste, valeur, masque FROM listes_reference WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!avant[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erreur: "Valeur introuvable." });
    }

    const { rows } = await client.query(
      `UPDATE listes_reference
          SET valeur = coalesce($2, valeur), masque = coalesce($3, masque)
        WHERE id = $1
        RETURNING id, liste, valeur, masque`,
      [id, valeur ?? null, masque ?? null]
    );

    // Renommer doit suivre les données déjà saisies, sinon l'ancienne
    // valeur reste dans les bandes et personne ne la retrouve dans la
    // liste. C'est la seule façon de renommer sans casser l'historique.
    if (valeur && valeur !== avant[0].valeur) {
      for (const { table, colonne } of USAGES[avant[0].liste] ?? []) {
        await client.query(
          `UPDATE ${table} SET ${colonne} = $2 WHERE ${colonne} = $1`,
          [avant[0].valeur, valeur]
        );
      }
    }

    await client.query("COMMIT");

    parAdmin(req, {
      action: "liste_modifiee",
      cibleType: "liste",
      cibleId: id,
      details: { liste: avant[0].liste, avant: avant[0], apres: rows[0] },
    });

    res.json({ valeur: rows[0] });
  } catch (erreur) {
    await client.query("ROLLBACK").catch(() => {});
    if (erreur.code === "23505") {
      return res.status(409).json({ erreur: "Une autre valeur porte déjà ce nom." });
    }
    console.error("Erreur modification de valeur :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

// DELETE /api/admin/listes/:id
async function supprimerValeur(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erreur: "Identifiant invalide." });

  try {
    const { rows } = await pool.query(
      "SELECT liste, valeur FROM listes_reference WHERE id = $1",
      [id]
    );
    if (!rows[0]) return res.status(404).json({ erreur: "Valeur introuvable." });

    const usages = await compterUsages(rows[0].liste, rows[0].valeur);
    if (usages > 0) {
      return res.status(409).json({
        erreur: `« ${rows[0].valeur} » est utilisée par ${usages} enregistrement${
          usages > 1 ? "s" : ""
        }. Masquez-la plutôt : elle disparaîtra des listes de l'ouvrier sans effacer l'historique.`,
      });
    }

    await pool.query("DELETE FROM listes_reference WHERE id = $1", [id]);

    parAdmin(req, {
      action: "liste_modifiee",
      cibleType: "liste",
      cibleId: id,
      details: { liste: rows[0].liste, suppression: rows[0].valeur },
    });

    res.json({ supprime: true });
  } catch (erreur) {
    console.error("Erreur suppression de valeur :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = {
  lireListes,
  listesPubliques,
  ajouterValeur,
  modifierValeur,
  supprimerValeur,
};
