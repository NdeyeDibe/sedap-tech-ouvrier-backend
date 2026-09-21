const pool = require("../db/pool");
const { normaliser, estValide, NB_CHIFFRES } = require("../utils/telephone");
const { creerStockInitial } = require("../utils/stockInitial");
const { parAdmin } = require("../services/journal");

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

module.exports = { creerOuvrierResponsable };
