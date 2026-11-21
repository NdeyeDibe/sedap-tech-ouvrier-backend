const pool = require("../db/pool");
const { parProprietaire, differences } = require("../services/journal");

// Les seules écritures autorisées au propriétaire hors ventes : son personnel,
// ses frais, son profil. Tout le reste de la production est en lecture seule.

async function fermeDu(proprietaireId) {
  const { rows } = await pool.query(
    "SELECT id FROM fermes WHERE proprietaire_id = $1",
    [proprietaireId]
  );
  return rows[0] ?? null;
}

// --------------------------------------------------------- personnel

// Le propriétaire n'ajoute que des ouvriers simples. Les responsables ont un
// compte, créé par SEDAP depuis le Sénégal : lui laisser les créer ramènerait
// le problème du SMS d'activation qui ne passe pas depuis l'étranger.
async function ajouterOuvrier(req, res) {
  const { prenom, telephone, poulaillerId, salaire, priseFonction } = req.body;

  if (!prenom || !String(prenom).trim()) {
    return res.status(400).json({ erreur: "Prénom requis." });
  }
  if (salaire == null || salaire < 0) {
    return res.status(400).json({ erreur: "Salaire requis." });
  }

  try {
    const ferme = await fermeDu(req.utilisateur.id);
    if (!ferme) return res.status(404).json({ erreur: "Aucune ferme." });

    // Le poulailler doit être le sien.
    if (poulaillerId) {
      const { rowCount } = await pool.query(
        "SELECT 1 FROM poulaillers WHERE id = $1 AND ferme_id = $2",
        [poulaillerId, ferme.id]
      );
      if (rowCount === 0) {
        return res.status(400).json({ erreur: "Poulailler inconnu." });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO personnel
         (ferme_id, poulailler_id, role, prenom, telephone, salaire, prise_fonction)
       VALUES ($1, $2, 'simple', $3, $4, $5, $6)
       RETURNING id`,
      [
        ferme.id,
        poulaillerId || null,
        String(prenom).trim(),
        telephone || null,
        salaire,
        priseFonction || new Date().toISOString().slice(0, 10),
      ]
    );

    parProprietaire(req, {
      action: "ouvrier_ajoute",
      cibleType: "personnel",
      cibleId: rows[0].id,
      fermeId: ferme.id,
      poulaillerId: poulaillerId || undefined,
      details: {
        prenom: String(prenom).trim(),
        telephone: telephone || null,
        salaire: Number(salaire),
        priseFonction: priseFonction || new Date().toISOString().slice(0, 10),
      },
    });

    res.status(201).json({ id: rows[0].id });
  } catch (erreur) {
    console.error("Erreur ajout d'un ouvrier :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// Sur un responsable, seul le salaire est modifiable : son identité appartient
// au compte créé par SEDAP.
async function modifierOuvrier(req, res) {
  const { personnelId } = req.params;
  const { prenom, telephone, poulaillerId, salaire } = req.body;

  try {
    const ferme = await fermeDu(req.utilisateur.id);
    if (!ferme) return res.status(404).json({ erreur: "Aucune ferme." });

    // Toute la ligne, pour que le journal garde les valeurs d'avant.
    const { rows } = await pool.query(
      "SELECT * FROM personnel WHERE id = $1 AND ferme_id = $2",
      [personnelId, ferme.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ erreur: "Ouvrier introuvable." });
    }
    const avant = rows[0];

    if (avant.role === "responsable") {
      // L'IDENTITÉ D'UN RESPONSABLE EST MODIFIABLE PAR SON PROPRIÉTAIRE.
      //
      // Elle ne l'était pas : le compte étant créé par SEDAP, l'écran
      // n'offrait que le salaire. Mais c'est le propriétaire qui voit son
      // responsable tous les jours, et un numéro mal saisi le laissait sans
      // recours — il fallait écrire à SEDAP (demande Mengué, 21 nov. 2026).
      //
      // Le compte lui-même vit dans `ouvriers` ; `personnel` n'en garde
      // qu'une copie pour l'affichage et les charges. Les deux se mettent à
      // jour ensemble, sinon le propriétaire corrige un prénom qui
      // réapparaît ailleurs sous son ancienne forme.
      return modifierResponsable(req, res, { ferme, avant });
    }

    await pool.query(
      `UPDATE personnel
          SET prenom = coalesce($1, prenom),
              telephone = coalesce($2, telephone),
              poulailler_id = coalesce($3, poulailler_id),
              salaire = coalesce($4, salaire)
        WHERE id = $5`,
      [
        prenom ? String(prenom).trim() : null,
        telephone ?? null,
        poulaillerId ?? null,
        salaire ?? null,
        personnelId,
      ]
    );

    const changements = differences(
      avant,
      {
        prenom: prenom ? String(prenom).trim() : undefined,
        telephone: telephone ?? undefined,
        poulailler_id: poulaillerId ?? undefined,
        salaire: salaire ?? undefined,
      },
      ["prenom", "telephone", "poulailler_id", "salaire"]
    );
    if (Object.keys(changements).length > 0) {
      parProprietaire(req, {
        action: changements.salaire && Object.keys(changements).length === 1
          ? "salaire_modifie"
          : "ouvrier_modifie",
        cibleType: "personnel",
        cibleId: avant.id,
        fermeId: ferme.id,
        poulaillerId: avant.poulailler_id ?? undefined,
        details: { prenom: avant.prenom, role: "simple", ...changements },
      });
    }

    res.json({ id: Number(personnelId) });
  } catch (erreur) {
    console.error("Erreur modification d'un ouvrier :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

/**
 * Le propriétaire corrige son responsable : prénom, nom, téléphone, salaire.
 *
 * LE TÉLÉPHONE EST LA CLÉ DE CONNEXION. Les mêmes règles qu'à l'admin
 * s'appliquent donc ici, et pour la même raison : 221 suivi de neuf
 * chiffres, et jamais deux comptes sur un même numéro — celui qui perdrait
 * le sien ne pourrait plus entrer dans l'application.
 *
 * Le propriétaire ne peut toucher qu'un responsable de SA ferme : l'appelant
 * a déjà vérifié le `ferme_id` avant d'arriver ici.
 */
async function modifierResponsable(req, res, { ferme, avant }) {
  const fourni = (v) => v !== undefined && v !== null && String(v).trim() !== "";

  const prenom = fourni(req.body.prenom) ? String(req.body.prenom).trim() : null;
  const nom = fourni(req.body.nom) ? String(req.body.nom).trim() : null;
  const telephone = fourni(req.body.telephone)
    ? String(req.body.telephone).replace(/[\s+]/g, "")
    : null;
  const salaire = req.body.salaire == null ? null : Number(req.body.salaire);

  if (salaire !== null && (!Number.isFinite(salaire) || salaire < 0)) {
    return res.status(400).json({ erreur: "Salaire invalide." });
  }
  if (telephone !== null && !/^221\d{9}$/.test(telephone)) {
    return res.status(400).json({
      erreur:
        "Numéro invalide. Attendu : 221 suivi des 9 chiffres (ex. 221771234567).",
    });
  }
  if (prenom === null && nom === null && telephone === null && salaire === null) {
    return res.status(400).json({ erreur: "Rien à modifier." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: comptes } = await client.query(
      "SELECT id, prenom, nom, telephone FROM ouvriers WHERE id = $1 FOR UPDATE",
      [avant.ouvrier_id]
    );
    const compte = comptes[0];
    if (!compte) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erreur: "Compte introuvable." });
    }

    if (telephone !== null && telephone !== compte.telephone) {
      const { rows: occupe } = await client.query(
        "SELECT prenom, nom FROM ouvriers WHERE telephone = $1 AND id <> $2",
        [telephone, compte.id]
      );
      if (occupe[0]) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          erreur:
            `Ce numéro est déjà celui de ${occupe[0].prenom} ${occupe[0].nom}. ` +
            `Deux comptes ne peuvent pas partager un numéro : c'est avec lui ` +
            `qu'on se connecte.`,
        });
      }
    }

    const apres = {
      prenom: prenom ?? compte.prenom,
      nom: nom ?? compte.nom,
      telephone: telephone ?? compte.telephone,
    };

    await client.query(
      "UPDATE ouvriers SET prenom = $2, nom = $3, telephone = $4 WHERE id = $1",
      [compte.id, apres.prenom, apres.nom, apres.telephone]
    );
    // La copie d'affichage suit le compte, sinon l'ancien prénom réapparaît
    // sur les charges et dans le résumé annuel.
    await client.query(
      `UPDATE personnel
          SET prenom = $2, telephone = $3, salaire = coalesce($4, salaire)
        WHERE id = $1`,
      [avant.id, apres.prenom, apres.telephone, salaire]
    );

    await client.query("COMMIT");

    const changements = {};
    if (apres.prenom !== compte.prenom)
      changements.prenom = { avant: compte.prenom, apres: apres.prenom };
    if (apres.nom !== compte.nom)
      changements.nom = { avant: compte.nom, apres: apres.nom };
    if (apres.telephone !== compte.telephone)
      changements.telephone = { avant: compte.telephone, apres: apres.telephone };
    if (salaire !== null && String(avant.salaire) !== String(salaire))
      changements.salaire = { avant: avant.salaire, apres: salaire };

    if (Object.keys(changements).length > 0) {
      parProprietaire(req, {
        action:
          Object.keys(changements).length === 1 && changements.salaire
            ? "salaire_modifie"
            : "ouvrier_modifie",
        cibleType: "personnel",
        cibleId: avant.id,
        fermeId: ferme.id,
        poulaillerId: avant.poulailler_id ?? undefined,
        details: { prenom: compte.prenom, role: "responsable", ...changements },
      });
    }

    res.json({
      id: Number(avant.id),
      ...apres,
      salaire: salaire ?? avant.salaire,
      telephoneChange: apres.telephone !== compte.telephone,
    });
  } catch (erreur) {
    await client.query("ROLLBACK");
    console.error("Erreur modification du responsable :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

// Un responsable ne se supprime pas côté propriétaire : son compte appartient
// à SEDAP. On marque une fin de fonction plutôt que d'effacer la ligne, pour
// que les mois déjà écoulés gardent leurs salaires dans le résumé annuel.
async function retirerOuvrier(req, res) {
  const { personnelId } = req.params;

  try {
    const ferme = await fermeDu(req.utilisateur.id);
    if (!ferme) return res.status(404).json({ erreur: "Aucune ferme." });

    const { rows } = await pool.query(
      "SELECT role, prenom, poulailler_id, salaire FROM personnel WHERE id = $1 AND ferme_id = $2 AND fin_fonction IS NULL",
      [personnelId, ferme.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ erreur: "Ouvrier introuvable." });
    }
    if (rows[0].role === "responsable") {
      return res.status(403).json({
        erreur: "Le compte d'un responsable est géré par SEDAP.",
      });
    }

    await pool.query(
      "UPDATE personnel SET fin_fonction = current_date WHERE id = $1",
      [personnelId]
    );

    parProprietaire(req, {
      action: "ouvrier_retire",
      cibleType: "personnel",
      cibleId: Number(personnelId),
      fermeId: ferme.id,
      poulaillerId: rows[0].poulailler_id ?? undefined,
      details: { prenom: rows[0].prenom, salaire: rows[0].salaire },
    });

    res.status(204).end();
  } catch (erreur) {
    console.error("Erreur retrait d'un ouvrier :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// ------------------------------------------------------------- frais

async function ajouterFrais(req, res) {
  const { description, montant, date, poulaillerId } = req.body;

  if (!description || !String(description).trim()) {
    return res.status(400).json({ erreur: "Description requise." });
  }
  if (montant == null || montant < 0) {
    return res.status(400).json({ erreur: "Montant invalide." });
  }
  if (!date) {
    return res.status(400).json({ erreur: "Date requise." });
  }

  try {
    const ferme = await fermeDu(req.utilisateur.id);
    if (!ferme) return res.status(404).json({ erreur: "Aucune ferme." });

    const { rows } = await pool.query(
      `INSERT INTO frais
         (ferme_id, poulailler_id, description, montant, date_depense, saisi_par)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, date_depense`,
      [
        ferme.id,
        poulaillerId || null,
        String(description).trim(),
        montant,
        date,
        req.utilisateur.id,
      ]
    );

    parProprietaire(req, {
      action: "frais_ajoute",
      cibleType: "frais",
      cibleId: rows[0].id,
      fermeId: ferme.id,
      poulaillerId: poulaillerId || undefined,
      details: {
        description: String(description).trim(),
        montant: Number(montant),
        date,
      },
    });

    // Le frais se rattache au mois de SA date. Si ce n'est pas le mois en
    // cours, l'écran doit le dire — sinon la saisie a l'air d'avoir échoué.
    const saisie = new Date(rows[0].date_depense);
    const maintenant = new Date();

    res.status(201).json({
      id: rows[0].id,
      date: rows[0].date_depense,
      moisEnCours:
        saisie.getMonth() === maintenant.getMonth() &&
        saisie.getFullYear() === maintenant.getFullYear(),
    });
  } catch (erreur) {
    console.error("Erreur ajout d'un frais :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

async function supprimerFrais(req, res) {
  const { fraisId } = req.params;

  try {
    const { rows, rowCount } = await pool.query(
      `DELETE FROM frais f
        USING fermes fe
        WHERE f.id = $1 AND fe.id = f.ferme_id AND fe.proprietaire_id = $2
        RETURNING f.*`,
      [fraisId, req.utilisateur.id]
    );

    if (rowCount === 0) {
      return res.status(404).json({ erreur: "Frais introuvable." });
    }

    parProprietaire(req, {
      action: "frais_supprime",
      cibleType: "frais",
      cibleId: rows[0].id,
      fermeId: rows[0].ferme_id,
      poulaillerId: rows[0].poulailler_id ?? undefined,
      details: { supprime: rows[0] },
    });

    res.status(204).end();
  } catch (erreur) {
    console.error("Erreur suppression d'un frais :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// ------------------------------------------------------------ profil

// Le téléphone est l'identifiant de connexion : le modifier ne l'applique pas
// tout de suite. Le nouveau numéro attend une confirmation, l'ancien reste
// actif — sinon quiconque accède au téléphone déverrouillé pourrait basculer
// le compte sur son propre numéro.
async function modifierProfil(req, res) {
  const { nom, prenom, email, telephone } = req.body;

  try {
    const { rows } = await pool.query(
      "SELECT telephone, nom, prenom, email FROM proprietaires WHERE id = $1",
      [req.utilisateur.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ erreur: "Propriétaire introuvable." });
    }

    await pool.query(
      `UPDATE proprietaires
          SET nom = coalesce($1, nom),
              prenom = coalesce($2, prenom),
              email = coalesce($3, email)
        WHERE id = $4`,
      [nom ?? null, prenom ?? null, email ?? null, req.utilisateur.id]
    );

    const changeTelephone =
      telephone && telephone.replace(/\D/g, "") !==
        rows[0].telephone.replace(/\D/g, "");

    const changements = differences(
      rows[0],
      { nom: nom ?? undefined, prenom: prenom ?? undefined, email: email ?? undefined },
      ["nom", "prenom", "email"]
    );
    if (changeTelephone) {
      changements.telephoneDemande = { avant: rows[0].telephone, apres: telephone };
    }
    if (Object.keys(changements).length > 0) {
      parProprietaire(req, {
        action: "profil_modifie",
        cibleType: "compte",
        cibleId: req.utilisateur.id,
        details: changements,
      });
    }

    res.json({
      telephoneEnAttente: changeTelephone ? telephone : null,
      // La vérification du nouveau numéro reste à écrire : elle demande un
      // canal d'envoi (WhatsApp) que le serveur n'a pas encore.
      verificationRequise: Boolean(changeTelephone),
    });
  } catch (erreur) {
    console.error("Erreur modification du profil :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = {
  ajouterOuvrier,
  modifierOuvrier,
  retirerOuvrier,
  ajouterFrais,
  supprimerFrais,
  modifierProfil,
};
