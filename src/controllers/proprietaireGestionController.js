const pool = require("../db/pool");

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

    const { rows } = await pool.query(
      "SELECT role FROM personnel WHERE id = $1 AND ferme_id = $2",
      [personnelId, ferme.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ erreur: "Ouvrier introuvable." });
    }

    if (rows[0].role === "responsable") {
      if (salaire == null || salaire < 0) {
        return res.status(400).json({ erreur: "Salaire requis." });
      }
      await pool.query("UPDATE personnel SET salaire = $1 WHERE id = $2", [
        salaire,
        personnelId,
      ]);
      return res.json({ id: Number(personnelId), salaire });
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

    res.json({ id: Number(personnelId) });
  } catch (erreur) {
    console.error("Erreur modification d'un ouvrier :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
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
      "SELECT role FROM personnel WHERE id = $1 AND ferme_id = $2 AND fin_fonction IS NULL",
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
    const { rowCount } = await pool.query(
      `DELETE FROM frais f
        USING fermes fe
        WHERE f.id = $1 AND fe.id = f.ferme_id AND fe.proprietaire_id = $2`,
      [fraisId, req.utilisateur.id]
    );

    if (rowCount === 0) {
      return res.status(404).json({ erreur: "Frais introuvable." });
    }

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
      "SELECT telephone FROM proprietaires WHERE id = $1",
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
