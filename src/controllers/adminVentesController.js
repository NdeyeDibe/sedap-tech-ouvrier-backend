const pool = require("../db/pool");
const { parAdmin, differences } = require("../services/journal");

// Correction et suppression d'une vente par SEDAP.
//
// Une vente fausse déforme directement le bilan : c'est de l'argent, et le
// propriétaire s'en sert pour juger sa bande. Jusqu'ici, le propriétaire
// pouvait supprimer ses propres ventes, mais celles saisies par l'ouvrier
// étaient définitives.
//
// Trois règles tiennent l'ensemble :
//
//  1. Motif obligatoire, et tout est journalisé (valeur avant et après).
//     Le propriétaire voit la correction sur sa bande.
//
//  2. On ne peut jamais vendre plus de sujets qu'il n'y en a eu. Le
//     déclencheur verifier_vente ne couvre que les insertions : une
//     correction doit refaire le calcul elle-même.
//
//  3. Si la correction laisse des sujets vivants sur une bande déjà
//     clôturée, la bande se rouvre. Une bande fermée avec des sujets
//     dedans, c'est un poulailler que l'ouvrier ne peut plus suivre ni
//     vendre. La clôture automatique (cloturer_si_vide) ne se déclenche
//     qu'à 0 restant : au-dessus, elle n'est plus justifiée.

const CHAMPS = ["quantite", "prix_unitaire", "nom_client", "telephone_client", "date_vente"];

const LIBELLES = {
  quantite: "Sujets vendus",
  prix_unitaire: "Prix unitaire",
  nom_client: "Client",
  telephone_client: "Téléphone du client",
  date_vente: "Date de la vente",
};

const DEPUIS_CORPS = {
  quantite: "quantite",
  prixUnitaire: "prix_unitaire",
  nomClient: "nom_client",
  telephoneClient: "telephone_client",
  dateVente: "date_vente",
};

const vide = (v) => v === null || v === undefined || v === "";

function entier(v) {
  if (vide(v)) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

function decimal(v) {
  if (vide(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function texte(v) {
  if (vide(v)) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}

// Charge la vente, son type, sa bande et de quoi vérifier la cohérence.
async function chargerVente(client, venteId) {
  const { rows } = await client.query(
    `SELECT v.id, v.bande_id, v.type_vente, ${CHAMPS.map((c) => `v.${c}`).join(", ")},
            b.numero AS bande_numero, b.statut AS bande_statut,
            effectif_initial(b.id) AS depart,
            sujets_morts(b.id) AS morts,
            sujets_vendus(b.id) AS vendus,
            coalesce((SELECT sum(d.quantite) FROM ventes_details d WHERE d.vente_id = v.id), 0)
              AS detail_quantite,
            coalesce((SELECT count(*) FROM ventes_details d WHERE d.vente_id = v.id), 0)
              AS detail_lignes
       FROM ventes v
       JOIN bandes b ON b.id = v.bande_id
      WHERE v.id = $1
        FOR UPDATE OF v`,
    [venteId]
  );
  return rows[0] ?? null;
}

// Rouvre la bande si la correction y laisse des sujets vivants.
//
// Un poulailler ne peut héberger qu'une seule bande non terminée à la fois
// (index une_seule_bande_active_par_poulailler). Si l'ouvrier a déjà
// démarré la bande suivante, rouvrir l'ancienne fait échouer la requête —
// et emporte la correction avec elle. Trouvé en test sur la question de
// Ndeye : la correction était perdue et l'écran affichait « Erreur
// serveur. » sans rien expliquer.
//
// On corrige donc toujours, et on rouvre seulement si c'est possible.
//
// @returns 'rouverte' | 'bloquee_par_bande_suivante' | 'sans_objet'
async function rouvrirSiNecessaire(client, vente) {
  if (vente.bande_statut !== "terminee") return "sans_objet";

  const { rows } = await client.query("SELECT effectif_restant($1) AS restant", [vente.bande_id]);
  const restant = Number(rows[0].restant);
  if (restant <= 0) return "sans_objet";

  const { rows: suivantes } = await client.query(
    `SELECT id, numero FROM bandes
      WHERE poulailler_id = (SELECT poulailler_id FROM bandes WHERE id = $1)
        AND id <> $1 AND statut <> 'terminee'
      LIMIT 1`,
    [vente.bande_id]
  );
  if (suivantes.length > 0) {
    // La correction reste valable ; c'est la réouverture qui ne l'est pas.
    return "bloquee_par_bande_suivante";
  }

  await client.query(
    "UPDATE bandes SET statut = 'en_vente', date_fin = NULL WHERE id = $1 AND statut = 'terminee'",
    [vente.bande_id]
  );
  return "rouverte";
}

// Ce que l'écran doit dire à l'admin, une fois la correction enregistrée.
async function messageReouverture(etat, bandeId) {
  if (etat === "rouverte") {
    return "La bande était clôturée et compte de nouveau des sujets vivants : elle a été rouverte.";
  }
  if (etat === "bloquee_par_bande_suivante") {
    const { rows } = await pool.query(
      `SELECT b.numero, effectif_restant($1) AS restant
         FROM bandes b
        WHERE b.poulailler_id = (SELECT poulailler_id FROM bandes WHERE id = $1)
          AND b.id <> $1 AND b.statut <> 'terminee'
        LIMIT 1`,
      [bandeId]
    );
    const n = rows[0];
    return (
      `Correction enregistrée, mais la bande reste clôturée : le poulailler a déjà la ` +
      `bande n°${n?.numero ?? "suivante"} en cours. ` +
      `${n?.restant ?? ""} sujets se retrouvent dans une bande fermée et ne seront plus suivis — ` +
      `vérifiez avec l'ouvrier ce qu'ils sont devenus.`
    );
  }
  return null;
}

// PATCH /api/admin/ventes/:id
async function corrigerVente(req, res) {
  const venteId = Number(req.params.id);
  if (!Number.isInteger(venteId)) {
    return res.status(400).json({ erreur: "Identifiant de vente invalide." });
  }

  const motif = texte(req.body.motif);
  if (!motif) {
    return res.status(400).json({ erreur: "Indiquez la raison de la correction." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const vente = await chargerVente(client, venteId);
    if (!vente) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erreur: "Vente introuvable." });
    }

    // Fusion : on ne touche qu'aux champs réellement envoyés.
    // Défauts pris sur la ligne normalisée (voir normaliser) : sinon le
    // prix, rendu en texte par PostgreSQL, paraîtrait modifié dès qu'on
    // corrige autre chose.
    const avant = normaliser(vente);
    const apres = {};
    for (const c of CHAMPS) apres[c] = avant[c];
    for (const [cle, colonne] of Object.entries(DEPUIS_CORPS)) {
      if (!(cle in req.body)) continue;
      const brut = req.body[cle];
      if (colonne === "quantite") apres[colonne] = entier(brut);
      else if (colonne === "prix_unitaire") apres[colonne] = decimal(brut);
      else apres[colonne] = texte(brut);
    }

    for (const [colonne, valeur] of Object.entries(apres)) {
      if (valeur === undefined) {
        await client.query("ROLLBACK");
        return res.status(400).json({ erreur: `${LIBELLES[colonne]} : valeur invalide.` });
      }
    }

    const probleme = verifier(apres, vente);
    if (probleme) {
      await client.query("ROLLBACK");
      return res.status(409).json({ erreur: probleme });
    }

    // PostgreSQL rend les NUMERIC en texte (« 3200.00 ») : comparés tels
    // quels à un nombre (3200), ils passent pour un changement. On aligne
    // avant de comparer, sinon le journal — et le propriétaire — voient
    // des corrections qui n'en sont pas.
    const diff = differences(avant, apres, CHAMPS);
    if (Object.keys(diff).length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ erreur: "Aucune modification : les valeurs sont identiques." });
    }

    await client.query(
      `UPDATE ventes
          SET quantite = $2, prix_unitaire = $3, nom_client = $4,
              telephone_client = $5, date_vente = coalesce($6::timestamptz, date_vente)
        WHERE id = $1`,
      [
        venteId,
        apres.quantite,
        apres.prix_unitaire,
        apres.nom_client,
        apres.telephone_client,
        apres.date_vente,
      ]
    );

    const reouverture = await rouvrirSiNecessaire(client, vente);
    await client.query("COMMIT");

    parAdmin(req, {
      action: "vente_corrigee",
      cibleType: "vente",
      cibleId: venteId,
      bandeId: vente.bande_id,
      details: {
        motif,
        reouverture,
        champs: Object.fromEntries(
          Object.entries(diff).map(([colonne, valeurs]) => [
            colonne,
            { libelle: LIBELLES[colonne], ...valeurs },
          ])
        ),
      },
    });

    res.json({
      id: venteId,
      corrections: Object.keys(diff).length,
      reouverture,
      message: await messageReouverture(reouverture, vente.bande_id),
    });
  } catch (erreur) {
    await client.query("ROLLBACK");
    console.error("Erreur correction vente :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

// Les montants en nombre, pour comparer ce qui est comparable.
function normaliser(ligne) {
  return {
    ...ligne,
    prix_unitaire: ligne.prix_unitaire === null ? null : Number(ligne.prix_unitaire),
  };
}

function verifier(apres, vente) {
  const q = apres.quantite;
  if (q === null || q <= 0) return "Sujets vendus : un nombre supérieur à 0 est attendu.";

  if (vente.type_vente === "ferme") {
    if (apres.prix_unitaire === null || apres.prix_unitaire < 0) {
      return "Prix unitaire : un montant positif est attendu pour une vente à la ferme.";
    }
  } else if (apres.prix_unitaire !== null) {
    // Contrainte vente_prix_selon_type : un ramassage n'a pas de prix, il
    // est chiffré ligne par ligne dans son détail.
    return "Un ramassage n'a pas de prix unitaire : il se chiffre dans son détail.";
  }

  if (!apres.nom_client) return "Client : le nom est obligatoire.";

  // Un ramassage déjà détaillé ne peut pas descendre sous la somme de ses
  // lignes, sinon le détail décrirait plus de sujets que le ramassage.
  const detail = Number(vente.detail_quantite);
  if (vente.type_vente === "ramassage" && detail > 0 && q < detail) {
    return (
      `Ce ramassage est déjà détaillé pour ${detail} sujets : la quantité ne peut pas ` +
      `descendre en dessous. Corrigez d'abord le détail.`
    );
  }

  // La règle d'ensemble : morts + vendus ne dépassent jamais le départ.
  const vendusApres = Number(vente.vendus) - Number(vente.quantite) + q;
  const depart = Number(vente.depart);
  const morts = Number(vente.morts);
  if (morts + vendusApres > depart) {
    return (
      `Impossible : avec ${q} sujets sur cette vente, le total vendu (${vendusApres}) ` +
      `et les morts (${morts}) dépasseraient l'effectif de départ (${depart}).`
    );
  }

  return null;
}

// DELETE /api/admin/ventes/:id
//
// Le détail d'un ramassage part avec la vente (clé étrangère ON DELETE
// CASCADE) : on le dit dans le journal, pour qu'on sache ce qui a disparu.
async function supprimerVente(req, res) {
  const venteId = Number(req.params.id);
  if (!Number.isInteger(venteId)) {
    return res.status(400).json({ erreur: "Identifiant de vente invalide." });
  }

  const motif = texte(req.body?.motif);
  if (!motif) {
    return res.status(400).json({ erreur: "Indiquez la raison de la suppression." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const vente = await chargerVente(client, venteId);
    if (!vente) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erreur: "Vente introuvable." });
    }

    await client.query("DELETE FROM ventes WHERE id = $1", [venteId]);

    const reouverture = await rouvrirSiNecessaire(client, vente);
    await client.query("COMMIT");

    parAdmin(req, {
      action: "vente_supprimee_admin",
      cibleType: "vente",
      cibleId: venteId,
      bandeId: vente.bande_id,
      details: {
        motif,
        reouverture,
        // La ligne supprimée en entier : c'est la seule trace qu'il en reste.
        vente: {
          type: vente.type_vente,
          client: vente.nom_client,
          quantite: Number(vente.quantite),
          prixUnitaire: vente.prix_unitaire === null ? null : Number(vente.prix_unitaire),
          date: vente.date_vente,
        },
        lignesDetailSupprimees: Number(vente.detail_lignes),
      },
    });

    res.json({
      id: venteId,
      supprimee: true,
      reouverture,
      message: await messageReouverture(reouverture, vente.bande_id),
    });
  } catch (erreur) {
    await client.query("ROLLBACK");
    console.error("Erreur suppression vente :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

module.exports = { corrigerVente, supprimerVente, LIBELLES_VENTE: LIBELLES };
