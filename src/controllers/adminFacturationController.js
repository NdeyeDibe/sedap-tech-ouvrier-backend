const pool = require("../db/pool");
const { parAdmin } = require("../services/journal");
const {
  facturesDeLaFerme,
  bandesSansFacture,
  facturerBandesOubliees,
} = require("../services/facturation");

// Facturation d'une ferme — factures de bandes et encaissements.
//
// Tant que Wave et Orange Money ne versent pas directement dans
// l'application, c'est SEDAP qui saisit ce qu'elle a reçu. Le jour où un
// agrégateur sera branché, il remplira la même table `paiements` : rien
// de ce qui est construit ici ne sera à refaire.

const MOYENS = ["wave", "orange_money", "free_money", "especes", "virement", "autre"];

// Un entier de francs, positif. Les centimes n'existent pas en FCFA.
function montantValide(valeur) {
  const n = Number(valeur);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// GET /api/admin/fermes/:id/factures
async function listerFactures(req, res) {
  const fermeId = Number(req.params.id);
  if (!Number.isInteger(fermeId)) {
    return res.status(400).json({ erreur: "Identifiant de ferme invalide." });
  }

  try {
    const [factures, sansFacture] = await Promise.all([
      facturesDeLaFerme(fermeId),
      bandesSansFacture(fermeId),
    ]);

    // Les totaux ne comptent que ce qui est chiffré et non annulé : une
    // facture « à fixer » n'est pas une dette tant que SEDAP n'a pas mis
    // de prix dessus.
    const chiffrees = factures.filter((f) => f.statut !== "annulee" && f.montant != null);

    res.json({
      factures,
      // Des bandes sans facture, c'est soit une période gratuite (normal),
      // soit une émission qui a échoué (à rattraper). L'écran propose le
      // rattrapage : s'il n'y a rien à facturer, il ne créera rien.
      bandesSansFacture: sansFacture,
      totaux: {
        du: chiffrees.reduce((t, f) => t + f.montant, 0),
        paye: chiffrees.reduce((t, f) => t + f.paye, 0),
        reste: chiffrees.reduce((t, f) => t + f.reste, 0),
        impayees: chiffrees.filter((f) => f.statut !== "payee").length,
        aFixer: factures.filter((f) => f.statut === "a_fixer").length,
      },
    });
  } catch (erreur) {
    console.error("Erreur liste des factures :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// POST /api/admin/fermes/:id/factures/rattrapage
async function rattraperFactures(req, res) {
  const fermeId = Number(req.params.id);
  if (!Number.isInteger(fermeId)) {
    return res.status(400).json({ erreur: "Identifiant de ferme invalide." });
  }

  try {
    const creees = await facturerBandesOubliees(fermeId);

    if (creees.length > 0) {
      parAdmin(req, {
        action: "factures_rattrapees",
        cibleType: "ferme",
        cibleId: fermeId,
        fermeId,
        details: { nombre: creees.length },
      });
    }

    res.json({ creees: creees.length });
  } catch (erreur) {
    console.error("Erreur rattrapage des factures :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// PATCH /api/admin/factures/:id
//
// Sert aux deux cas où la grille ne répond pas : « sur devis » au-delà de
// 12 000 sujets, et les tailles de bande qu'un pack ne couvre pas. Sert
// aussi à annuler une facture émise à tort.
async function modifierFacture(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ erreur: "Identifiant de facture invalide." });
  }

  const veutAnnuler = req.body?.annuler === true;
  const montant = veutAnnuler ? null : montantValide(req.body?.montant);

  if (!veutAnnuler && montant === null) {
    return res.status(400).json({ erreur: "Montant invalide : un nombre de francs supérieur à 0 est attendu." });
  }

  try {
    const { rows: avant } = await pool.query("SELECT * FROM factures WHERE id = $1", [id]);
    const facture = avant[0];
    if (!facture) return res.status(404).json({ erreur: "Facture introuvable." });

    if (veutAnnuler) {
      // Une facture déjà encaissée ne s'annule pas en silence : il faudrait
      // d'abord retirer les paiements, sinon l'argent reçu ne se rattache
      // plus à rien.
      const { rows: payes } = await pool.query(
        "SELECT count(*)::int AS n FROM paiements WHERE facture_id = $1",
        [id]
      );
      if (payes[0].n > 0) {
        return res.status(409).json({
          erreur: "Cette facture a des paiements enregistrés. Retirez-les avant de l'annuler.",
        });
      }

      const motif = String(req.body?.motif ?? "").trim() || null;
      await pool.query(
        "UPDATE factures SET annulee_le = now(), annulee_motif = $2 WHERE id = $1",
        [id, motif]
      );
      parAdmin(req, {
        action: "facture_annulee",
        cibleType: "facture",
        cibleId: id,
        fermeId: facture.ferme_id,
        details: { motif },
      });
      return res.json({ ok: true });
    }

    // montant_fixe_le fait partir le délai de paiement : avant, l'éleveur
    // n'avait reçu aucune somme à régler (services/verrou.js).
    await pool.query(
      `UPDATE factures
          SET montant = $2, motif = NULL,
              montant_fixe_le = COALESCE(montant_fixe_le, now())
        WHERE id = $1`,
      [id, montant]
    );
    parAdmin(req, {
      action: "facture_chiffree",
      cibleType: "facture",
      cibleId: id,
      fermeId: facture.ferme_id,
      details: { avant: facture.montant, apres: montant },
    });
    res.json({ ok: true });
  } catch (erreur) {
    console.error("Erreur modification de facture :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// POST /api/admin/factures/:id/paiements
async function enregistrerPaiement(req, res) {
  const factureId = Number(req.params.id);
  if (!Number.isInteger(factureId)) {
    return res.status(400).json({ erreur: "Identifiant de facture invalide." });
  }

  const montant = montantValide(req.body?.montant);
  if (montant === null) {
    return res.status(400).json({ erreur: "Montant invalide : un nombre de francs supérieur à 0 est attendu." });
  }

  const moyen = String(req.body?.moyen ?? "").trim();
  if (!MOYENS.includes(moyen)) {
    return res.status(400).json({ erreur: "Moyen de paiement inconnu." });
  }

  const reference = String(req.body?.reference ?? "").trim() || null;
  const recuLe = String(req.body?.recuLe ?? "").trim();
  if (recuLe && !/^\d{4}-\d{2}-\d{2}$/.test(recuLe)) {
    return res.status(400).json({ erreur: "Date de réception invalide." });
  }

  try {
    const { rows: factures } = await pool.query(
      "SELECT id, ferme_id, montant, annulee_le FROM factures WHERE id = $1",
      [factureId]
    );
    const facture = factures[0];
    if (!facture) return res.status(404).json({ erreur: "Facture introuvable." });
    if (facture.annulee_le) {
      return res.status(409).json({ erreur: "Cette facture est annulée." });
    }
    if (facture.montant == null) {
      return res.status(409).json({
        erreur: "Fixez d'abord le montant de cette facture.",
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO paiements (facture_id, montant, moyen, reference, recu_le, saisi_par)
       VALUES ($1, $2, $3, $4, COALESCE($5::date, current_date), $6)
       RETURNING id`,
      [factureId, montant, moyen, reference, recuLe || null, req.utilisateur.id]
    );

    parAdmin(req, {
      action: "paiement_enregistre",
      cibleType: "facture",
      cibleId: factureId,
      fermeId: facture.ferme_id,
      details: { montant, moyen, reference },
    });

    res.status(201).json({ id: rows[0].id });
  } catch (erreur) {
    console.error("Erreur enregistrement du paiement :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// DELETE /api/admin/paiements/:id — une saisie erronée se retire.
async function supprimerPaiement(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ erreur: "Identifiant de paiement invalide." });
  }

  try {
    const { rows } = await pool.query(
      `DELETE FROM paiements p
        USING factures fa
        WHERE p.id = $1 AND fa.id = p.facture_id
        RETURNING p.montant, p.moyen, fa.id AS facture_id, fa.ferme_id`,
      [id]
    );
    const supprime = rows[0];
    if (!supprime) return res.status(404).json({ erreur: "Paiement introuvable." });

    parAdmin(req, {
      action: "paiement_retire",
      cibleType: "facture",
      cibleId: supprime.facture_id,
      fermeId: supprime.ferme_id,
      details: { montant: Number(supprime.montant), moyen: supprime.moyen },
    });

    res.json({ ok: true });
  } catch (erreur) {
    console.error("Erreur suppression du paiement :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// PATCH /api/admin/factures/:id/delai
//
// La soupape du verrou automatique. Un bon client en déplacement, un
// paiement en espèces remis à un commercial, une panne de l'agrégateur :
// sans ce bouton, SEDAP devrait enregistrer un faux encaissement pour
// débloquer quelqu'un, et le registre des paiements mentirait.
//
// Une date, pas un déblocage définitif : le délai se périme tout seul.
async function accorderDelai(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ erreur: "Identifiant de facture invalide." });
  }

  const jusquau = String(req.body?.jusquau ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(jusquau)) {
    return res.status(400).json({ erreur: "Date de délai invalide." });
  }
  // Fin de journée : un délai « jusqu'au 3 » couvre le 3 en entier.
  const limite = new Date(`${jusquau}T23:59:59`);
  if (Number.isNaN(limite.getTime()) || limite.getTime() <= Date.now()) {
    return res.status(400).json({ erreur: "Le délai doit se terminer dans le futur." });
  }

  const motif = String(req.body?.motif ?? "").trim() || null;

  try {
    const { rows } = await pool.query(
      `UPDATE factures
          SET delai_jusquau = $2, delai_motif = $3, delai_par = $4
        WHERE id = $1 AND annulee_le IS NULL
        RETURNING ferme_id`,
      [id, limite.toISOString(), motif, req.utilisateur.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ erreur: "Facture introuvable ou annulée." });
    }

    parAdmin(req, {
      action: "delai_accorde",
      cibleType: "facture",
      cibleId: id,
      fermeId: rows[0].ferme_id,
      details: { jusquau, motif },
    });

    res.json({ ok: true });
  } catch (erreur) {
    console.error("Erreur délai de paiement :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = {
  MOYENS,
  accorderDelai,
  listerFactures,
  rattraperFactures,
  modifierFacture,
  enregistrerPaiement,
  supprimerPaiement,
};
