const pool = require("../db/pool");
const { normaliser, estValide, NB_CHIFFRES } = require("../utils/telephone");
const { creerStockInitial } = require("../utils/stockInitial");
const { parAdmin } = require("../services/journal");

// Un champ texte venu du formulaire : vide ou absent devient null, pour
// que la recherche « tout afficher » et « chercher une chaîne vide » ne
// soient pas deux choses différentes.
const texte = (valeur) => {
  const t = String(valeur ?? "").trim();
  return t === "" ? null : t;
};

// Ouvriers responsables — cahier admin v1.1, section VII.
//
// Créés par SEDAP depuis la fiche d'un poulailler, jamais depuis une route
// publique : c'est ce contrôleur qui remplace /api/auth/pre-inscrire.
// Pas d'e-mail ni de mot de passe : l'ouvrier crée son PIN à la première
// connexion, sur le compte préparé ici.

// Adresse de l'appli ouvrier, pour le message à lui transmettre.
const URL_OUVRIER = process.env.OUVRIER_URL || null;

// Format déjà en base pour les ouvriers : 221 suivi des 9 chiffres, sans
// « + ». On le garde, pour que tous les comptes aient la même forme.
const auFormatOuvrier = (valeur) => `221${normaliser(valeur)}`;

// POST /api/admin/poulaillers/:id/ouvrier
async function creerOuvrierResponsable(req, res) {
  const poulaillerId = Number(req.params.id);
  const prenom = String(req.body.prenom ?? "").trim();
  const nom = String(req.body.nom ?? "").trim();
  const { telephone } = req.body;

  if (!prenom || !nom) {
    return res.status(400).json({ erreur: "Prénom et nom requis." });
  }
  if (!estValide(telephone)) {
    return res.status(400).json({
      erreur: `Téléphone invalide : ${NB_CHIFFRES} chiffres attendus (ex. 77 123 45 67).`,
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Verrou sur le poulailler : deux admins qui ajoutent un responsable au
    // même moment ne peuvent pas passer tous les deux.
    const { rows: poulaillers } = await client.query(
      `SELECT pl.id, pl.nom, pl.ferme_id, pl.archive_le, f.nom AS ferme_nom
         FROM poulaillers pl
         LEFT JOIN fermes f ON f.id = pl.ferme_id
        WHERE pl.id = $1
        FOR UPDATE OF pl`,
      [poulaillerId]
    );
    const poulailler = poulaillers[0];

    if (!poulailler) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erreur: "Poulailler introuvable." });
    }
    if (poulailler.archive_le) {
      await client.query("ROLLBACK");
      return res.status(409).json({ erreur: "Ce poulailler est archivé." });
    }
    // Un responsable se rattache à une ferme (paie, propriétaire, alertes).
    if (!poulailler.ferme_id) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        erreur: "Ce poulailler n'est rattaché à aucune ferme. Rattachez-le d'abord.",
      });
    }

    const { rows: enPoste } = await client.query(
      `SELECT pe.prenom FROM personnel pe
        WHERE pe.poulailler_id = $1 AND pe.role = 'responsable' AND pe.fin_fonction IS NULL`,
      [poulaillerId]
    );
    if (enPoste.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        erreur: `${enPoste[0].prenom} est déjà responsable de ce poulailler. Retirez-le d'abord.`,
      });
    }

    // Unicité sur les 9 derniers chiffres, comme la connexion : un même
    // numéro écrit avec ou sans indicatif reste le même ouvrier.
    const { rows: memeNumero } = await client.query(
      `SELECT id, prenom, nom FROM ouvriers
        WHERE right(regexp_replace(telephone, '\\D', '', 'g'), ${NB_CHIFFRES}) = $1`,
      [normaliser(telephone)]
    );
    if (memeNumero.length > 0) {
      await client.query("ROLLBACK");
      const o = memeNumero[0];
      return res.status(409).json({
        erreur: `Ce numéro a déjà un compte (${[o.prenom, o.nom].filter(Boolean).join(" ")}).`,
      });
    }

    const { rows: crees } = await client.query(
      `INSERT INTO ouvriers (telephone, prenom, nom)
       VALUES ($1, $2, $3)
       RETURNING id, telephone, prenom, nom`,
      [auFormatOuvrier(telephone), prenom, nom]
    );
    const ouvrier = crees[0];

    // La ligne personnel EST le rattachement : c'est elle que lit l'API
    // ouvrier (utils/poulailler.js). Salaire vide : c'est au propriétaire
    // de le fixer.
    await client.query(
      `INSERT INTO personnel
         (ferme_id, poulailler_id, ouvrier_id, role, prenom, telephone, salaire, prise_fonction)
       VALUES ($1, $2, $3, 'responsable', $4, $5, NULL, current_date)`,
      [poulailler.ferme_id, poulaillerId, ouvrier.id, prenom, ouvrier.telephone]
    );

    // Un poulailler neuf n'a pas encore son catalogue de stock.
    await creerStockInitial(client, poulaillerId);

    await client.query("COMMIT");

    // Après le COMMIT, hors transaction : le journal ne doit jamais faire
    // échouer la création (cahier admin X bis).
    parAdmin(req, {
      action: "ouvrier_responsable_cree",
      cibleType: "ouvrier",
      cibleId: ouvrier.id,
      poulaillerId,
      fermeId: poulailler.ferme_id,
      details: { prenom, nom, telephone: ouvrier.telephone, poulailler: poulailler.nom },
    });

    // TODO(ENVOI) : pas encore de service SMS. L'écran admin affiche ce
    // message avec un bouton « Copier », pour que SEDAP l'envoie elle-même.
    const messageActivation =
      `Bonjour ${prenom}, votre compte SEDAP'Tech est prêt pour ${poulailler.nom ?? "votre poulailler"}` +
      (poulailler.ferme_nom ? ` (${poulailler.ferme_nom})` : "") +
      `. ${URL_OUVRIER ? `Ouvrez ${URL_OUVRIER}, ` : "Ouvrez l'application, "}` +
      `entrez votre numéro et créez votre code à 4 chiffres.`;

    res.status(201).json({
      ouvrier: {
        id: ouvrier.id,
        prenom: ouvrier.prenom,
        nom: ouvrier.nom,
        telephone: ouvrier.telephone,
        pinCree: false,
      },
      poulaillerId,
      messageActivation,
    });
  } catch (erreur) {
    await client.query("ROLLBACK");
    // Les index uniques de 017 tiennent la règle même en cas de course.
    if (erreur.code === "23505") {
      return res.status(409).json({ erreur: "Ce poulailler ou ce numéro est déjà pris." });
    }
    console.error("Erreur création ouvrier responsable :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

// ---------------------------------------------- voir et gérer les comptes

/**
 * GET /api/admin/ouvriers?recherche=
 *
 * TOUS les comptes responsables, rattachés ou non.
 *
 * Pourquoi cet écran existe : jusqu'ici un compte ne se voyait QUE par la
 * ferme où il travaille. Un responsable retiré de son poste, ou dont le
 * poulailler a été archivé, devenait introuvable — alors que son compte
 * existait toujours et que son numéro restait pris. SEDAP tentait de le
 * recréer, et se faisait répondre « ce numéro a déjà un compte », sans
 * aucun moyen de retrouver lequel (cas Tchernandjai, oct. 2026).
 *
 * « supprimable » : un compte ne s'efface que s'il n'a jamais servi —
 * aucun code créé, aucune vente à son nom. Dès qu'il a travaillé, son
 * historique doit rester lisible : on le retire du poste, on ne l'efface
 * pas (décision Ndeye, oct. 2026).
 */
async function listerOuvriers(req, res) {
  const recherche = texte(req.query.recherche);

  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.prenom, o.nom, o.telephone,
              (o.pin_hash IS NOT NULL) AS pin_cree,
              o.compte_verrouille, o.verrouille_le, o.cree_le,
              pe.poulailler_id, pe.prise_fonction,
              pl.nom AS poulailler_nom, pl.archive_le,
              f.id AS ferme_id, f.nom AS ferme_nom,
              (SELECT count(*) FROM ventes v WHERE v.auteur_ouvrier_id = o.id) AS ventes
         FROM ouvriers o
         LEFT JOIN personnel pe
           ON pe.ouvrier_id = o.id AND pe.role = 'responsable' AND pe.fin_fonction IS NULL
         LEFT JOIN poulaillers pl ON pl.id = pe.poulailler_id
         LEFT JOIN fermes f ON f.id = pe.ferme_id
        WHERE $1::text IS NULL
           OR o.prenom ILIKE '%' || $1 || '%'
           OR coalesce(o.nom, '') ILIKE '%' || $1 || '%'
           -- La recherche par numéro ne s'applique QUE si la saisie
           -- contient des chiffres. Sinon « Tchern » devient une chaîne
           -- vide une fois les lettres retirées, et LIKE '%%' ramenait
           -- tous les comptes (défaut trouvé au test, oct. 2026).
           OR (regexp_replace($1, '\\D', '', 'g') <> ''
               AND regexp_replace(o.telephone, '\\D', '', 'g')
                   LIKE '%' || regexp_replace($1, '\\D', '', 'g') || '%')
        ORDER BY o.prenom, o.nom`,
      [recherche || null]
    );

    // Les poulaillers sans responsable, pour la liste « rattacher à ».
    // Le serveur est le seul à savoir lesquels sont libres, et il le sait
    // dans la même requête : inutile d'en faire une deuxième côté admin.
    const { rows: libres } = await pool.query(
      `SELECT pl.id, pl.nom AS poulailler, f.nom AS ferme
         FROM poulaillers pl
         JOIN fermes f ON f.id = pl.ferme_id
         LEFT JOIN personnel pe
           ON pe.poulailler_id = pl.id AND pe.role = 'responsable' AND pe.fin_fonction IS NULL
        WHERE pl.archive_le IS NULL AND pe.id IS NULL
        ORDER BY f.nom, pl.nom`
    );

    res.json({
      poulaillersLibres: libres.map((p) => ({ id: p.id, nom: `${p.ferme} · ${p.poulailler}` })),
      ouvriers: rows.map((o) => {
        const ventes = Number(o.ventes);
        const supprimable = !o.pin_cree && ventes === 0;
        return {
          id: o.id,
          prenom: o.prenom,
          nom: o.nom,
          telephone: o.telephone,
          pinCree: o.pin_cree,
          verrouille: o.compte_verrouille,
          creeLe: o.cree_le,
          ventes,
          rattachement: o.poulailler_id
            ? {
                poulaillerId: o.poulailler_id,
                poulailler: o.poulailler_nom,
                fermeId: o.ferme_id,
                ferme: o.ferme_nom,
                depuis: o.prise_fonction,
                poulaillerArchive: Boolean(o.archive_le),
              }
            : null,
          supprimable,
          raison: supprimable
            ? null
            : o.pin_cree
              ? "Ce compte a déjà servi : son code a été créé."
              : `${ventes} vente(s) enregistrée(s) à son nom.`,
        };
      }),
    });
  } catch (erreur) {
    console.error("Erreur liste des responsables :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

/**
 * PATCH /api/admin/ouvriers/:id/rattacher — { poulaillerId }
 *
 * Remet un compte existant en poste. C'est la bonne réponse à « ce numéro
 * a déjà un compte » : on ne recrée pas, on rebranche.
 */
async function rattacherOuvrier(req, res) {
  const id = Number(req.params.id);
  const poulaillerId = Number(req.body?.poulaillerId);
  if (!Number.isInteger(id) || !Number.isInteger(poulaillerId)) {
    return res.status(400).json({ erreur: "Identifiants invalides." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: ouvriers } = await client.query(
      "SELECT id, prenom, nom, telephone FROM ouvriers WHERE id = $1 FOR UPDATE",
      [id]
    );
    const ouvrier = ouvriers[0];
    if (!ouvrier) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erreur: "Compte introuvable." });
    }

    const { rows: poulaillers } = await client.query(
      "SELECT id, nom, ferme_id, archive_le FROM poulaillers WHERE id = $1",
      [poulaillerId]
    );
    const poulailler = poulaillers[0];
    if (!poulailler || poulailler.archive_le) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erreur: "Poulailler introuvable ou archivé." });
    }
    if (!poulailler.ferme_id) {
      await client.query("ROLLBACK");
      return res.status(409).json({ erreur: "Ce poulailler n'est rattaché à aucune ferme." });
    }

    const { rows: occupe } = await client.query(
      `SELECT prenom FROM personnel
        WHERE poulailler_id = $1 AND role = 'responsable' AND fin_fonction IS NULL`,
      [poulaillerId]
    );
    if (occupe.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        erreur: `${occupe[0].prenom} est déjà responsable de ce poulailler. Retirez-le d'abord.`,
      });
    }

    // Un responsable ne tient qu'un poulailler : on clôt l'ancien poste.
    await client.query(
      `UPDATE personnel SET fin_fonction = current_date
        WHERE ouvrier_id = $1 AND role = 'responsable' AND fin_fonction IS NULL`,
      [id]
    );

    await client.query(
      `INSERT INTO personnel
         (ferme_id, poulailler_id, ouvrier_id, role, prenom, telephone, salaire, prise_fonction)
       VALUES ($1, $2, $3, 'responsable', $4, $5, NULL, current_date)`,
      [poulailler.ferme_id, poulaillerId, id, ouvrier.prenom, ouvrier.telephone]
    );

    await client.query("COMMIT");

    parAdmin(req, {
      action: "ouvrier_rattache",
      cibleType: "ouvrier",
      cibleId: id,
      poulaillerId,
      fermeId: poulailler.ferme_id,
      details: { prenom: ouvrier.prenom, poulailler: poulailler.nom },
    });

    res.json({ ouvrierId: id, poulailler: poulailler.nom });
  } catch (erreur) {
    await client.query("ROLLBACK");
    console.error("Erreur rattachement du responsable :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

/**
 * PATCH /api/admin/ouvriers/:id/retirer — le sort de son poste.
 *
 * Le compte et tout son historique restent : c'est le rattachement qui
 * s'arrête, et le poulailler redevient libre.
 */
async function retirerOuvrier(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erreur: "Identifiant invalide." });

  try {
    const { rows } = await pool.query(
      `UPDATE personnel SET fin_fonction = current_date
        WHERE ouvrier_id = $1 AND role = 'responsable' AND fin_fonction IS NULL
        RETURNING poulailler_id, ferme_id, prenom`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(409).json({ erreur: "Ce compte n'est rattaché à aucun poulailler." });
    }

    // Colonne héritée des premières versions, encore lue par endroits :
    // la laisser pointer sur un responsable retiré le ferait réapparaître.
    await pool.query("UPDATE poulaillers SET ouvrier_id = NULL WHERE ouvrier_id = $1", [id]);

    parAdmin(req, {
      action: "ouvrier_retire",
      cibleType: "ouvrier",
      cibleId: id,
      poulaillerId: rows[0].poulailler_id,
      fermeId: rows[0].ferme_id,
      details: { prenom: rows[0].prenom },
    });

    res.json({ ouvrierId: id, retires: rows.length });
  } catch (erreur) {
    console.error("Erreur retrait du responsable :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

/**
 * DELETE /api/admin/ouvriers/:id — efface un compte JAMAIS utilisÉ.
 *
 * Le seul cas légitime : un compte créé par erreur, dont le numéro doit
 * être réutilisable. Dès qu'un code a été créé ou qu'une vente porte son
 * nom, on refuse et on renvoie vers le retrait du poste.
 */
async function supprimerOuvrier(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erreur: "Identifiant invalide." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT o.id, o.prenom, o.nom, o.telephone, (o.pin_hash IS NOT NULL) AS pin_cree,
              (SELECT count(*) FROM ventes v WHERE v.auteur_ouvrier_id = o.id) AS ventes
         FROM ouvriers o WHERE o.id = $1 FOR UPDATE`,
      [id]
    );
    const ouvrier = rows[0];
    if (!ouvrier) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erreur: "Compte introuvable." });
    }
    if (ouvrier.pin_cree || Number(ouvrier.ventes) > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        erreur: ouvrier.pin_cree
          ? "Ce compte a déjà servi : son code a été créé. Retirez-le de son poste plutôt que de l'effacer — son historique doit rester lisible."
          : `${ouvrier.ventes} vente(s) sont à son nom. Retirez-le de son poste plutôt que de l'effacer.`,
      });
    }

    await client.query("UPDATE poulaillers SET ouvrier_id = NULL WHERE ouvrier_id = $1", [id]);
    await client.query("DELETE FROM personnel WHERE ouvrier_id = $1", [id]);
    await client.query("DELETE FROM ouvriers WHERE id = $1", [id]);

    await client.query("COMMIT");

    parAdmin(req, {
      action: "ouvrier_supprime",
      cibleType: "ouvrier",
      cibleId: id,
      details: {
        prenom: ouvrier.prenom,
        nom: ouvrier.nom,
        telephone: ouvrier.telephone,
      },
    });

    res.json({ supprime: id, telephoneLibere: ouvrier.telephone });
  } catch (erreur) {
    await client.query("ROLLBACK");
    console.error("Erreur suppression du responsable :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

module.exports = {
  creerOuvrierResponsable,
  listerOuvriers,
  rattacherOuvrier,
  retirerOuvrier,
  supprimerOuvrier,
};
