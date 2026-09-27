const pool = require("../db/pool");
const { parAdmin, differences } = require("../services/journal");

// Correction d'une réception de stock par SEDAP.
//
// Une réception mal saisie fausse deux choses à la fois : le stock
// disponible (l'ouvrier croit avoir de l'aliment qu'il n'a pas, ou
// l'inverse) et les dépenses de la bande. Les deux se réparent ici.
//
// Le stock n'est pas recalculé à partir des réceptions : il est tenu à
// jour ligne à ligne par le contrôleur des réceptions (stockController).
// Corriger une quantité impose donc d'ajuster le stock du même écart,
// sinon les deux divergent définitivement.
//
// Le garde-fou qui compte : on refuse une correction qui rendrait le stock
// négatif. Si 50 sacs ont été reçus et que 30 ont déjà été consommés, on ne
// peut pas ramener la réception à 5.

const CHAMPS = ["quantite_recue", "prix_unitaire", "provenance", "date_reception"];

const LIBELLES = {
  quantite_recue: "Quantité reçue",
  prix_unitaire: "Prix unitaire",
  provenance: "Provenance",
  date_reception: "Date de réception",
};

const DEPUIS_CORPS = {
  quantiteRecue: "quantite_recue",
  prixUnitaire: "prix_unitaire",
  provenance: "provenance",
  dateReception: "date_reception",
};

// PostgreSQL rend les NUMERIC en texte : on les ramène à des nombres
// avant toute comparaison.
function normaliser(ligne) {
  return {
    ...ligne,
    quantite_recue: ligne.quantite_recue === null ? null : Number(ligne.quantite_recue),
    prix_unitaire: ligne.prix_unitaire === null ? null : Number(ligne.prix_unitaire),
  };
}

const vide = (v) => v === null || v === undefined || v === "";

function nombre(v) {
  if (vide(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function texte(v) {
  if (vide(v)) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}

// PATCH /api/admin/receptions/:id
async function corrigerReception(req, res) {
  const receptionId = Number(req.params.id);
  if (!Number.isInteger(receptionId)) {
    return res.status(400).json({ erreur: "Identifiant de réception invalide." });
  }

  const motif = texte(req.body.motif);
  if (!motif) {
    return res.status(400).json({ erreur: "Indiquez la raison de la correction." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Verrou sur la ligne de stock aussi : deux corrections simultanées sur
    // le même produit se marcheraient dessus dans le calcul de l'écart.
    const { rows } = await client.query(
      `SELECT r.id, r.stock_produit_id, r.source,
              ${CHAMPS.map((c) => `r.${c}`).join(", ")},
              sp.nom AS produit_nom, sp.unite, sp.quantite AS stock_actuel,
              sp.poulailler_id
         FROM stock_receptions r
         JOIN stock_produits sp ON sp.id = r.stock_produit_id
        WHERE r.id = $1
          FOR UPDATE OF r, sp`,
      [receptionId]
    );
    const reception = rows[0];
    if (!reception) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erreur: "Réception introuvable." });
    }

    // Les valeurs par défaut viennent de la ligne NORMALISÉE : sinon le
    // prix resterait en texte (« 420.00 ») d'un côté et deviendrait un
    // nombre de l'autre, et paraîtrait modifié à chaque correction.
    const avant = normaliser(reception);
    const apres = {};
    for (const c of CHAMPS) apres[c] = avant[c];
    for (const [cle, colonne] of Object.entries(DEPUIS_CORPS)) {
      if (!(cle in req.body)) continue;
      const brut = req.body[cle];
      if (colonne === "quantite_recue" || colonne === "prix_unitaire") apres[colonne] = nombre(brut);
      else apres[colonne] = texte(brut);
    }

    for (const [colonne, valeur] of Object.entries(apres)) {
      if (valeur === undefined) {
        await client.query("ROLLBACK");
        return res.status(400).json({ erreur: `${LIBELLES[colonne]} : valeur invalide.` });
      }
    }

    if (apres.quantite_recue === null || apres.quantite_recue <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ erreur: "Quantité reçue : un nombre supérieur à 0 est attendu." });
    }
    if (apres.prix_unitaire !== null && apres.prix_unitaire < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ erreur: "Prix unitaire : un montant positif est attendu." });
    }
    // Même règle qu'à la saisie (contrainte reception_prix_si_ouvrier) :
    // une réception payée par l'ouvrier porte son prix.
    if (reception.source === "ouvrier" && apres.prix_unitaire === null) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        erreur: "Le prix est obligatoire quand c'est l'ouvrier qui a payé cette réception.",
      });
    }

    // L'écart à répercuter sur le stock disponible.
    const ecart = apres.quantite_recue - avant.quantite_recue;
    const stockApres = Number(reception.stock_actuel) + ecart;
    if (stockApres < 0) {
      await client.query("ROLLBACK");
      const consomme = Number(reception.quantite_recue) - Number(reception.stock_actuel);
      return res.status(409).json({
        erreur:
          `Impossible : il ne reste que ${Number(reception.stock_actuel)} ${reception.unite} ` +
          `de ${reception.produit_nom} en stock. Ramener cette réception à ` +
          `${apres.quantite_recue} donnerait un stock négatif ` +
          `(environ ${consomme} ${reception.unite} ont déjà été utilisés).`,
      });
    }

    const diff = differences(avant, apres, CHAMPS);
    if (Object.keys(diff).length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ erreur: "Aucune modification : les valeurs sont identiques." });
    }

    await client.query(
      `UPDATE stock_receptions
          SET quantite_recue = $2, prix_unitaire = $3, provenance = $4,
              date_reception = coalesce($5::timestamptz, date_reception)
        WHERE id = $1`,
      [receptionId, apres.quantite_recue, apres.prix_unitaire, apres.provenance, apres.date_reception]
    );

    if (ecart !== 0) {
      await client.query("UPDATE stock_produits SET quantite = quantite + $1 WHERE id = $2", [
        ecart,
        reception.stock_produit_id,
      ]);
    }

    await client.query("COMMIT");

    // La bande concernée : la vue receptions_ferme la déduit de la date.
    // Sans elle, la correction n'apparaîtrait ni dans le journal de la
    // bande ni chez le propriétaire.
    const { rows: rattachement } = await pool.query(
      "SELECT bande_id FROM receptions_ferme WHERE origine = 'produit' AND id = $1",
      [receptionId]
    );

    parAdmin(req, {
      action: "reception_corrigee",
      cibleType: "reception",
      cibleId: receptionId,
      poulaillerId: reception.poulailler_id,
      bandeId: rattachement[0]?.bande_id ?? undefined,
      details: {
        motif,
        produit: reception.produit_nom,
        stockAjuste: ecart === 0 ? null : { ecart, unite: reception.unite, apres: stockApres },
        champs: Object.fromEntries(
          Object.entries(diff).map(([colonne, valeurs]) => [
            colonne,
            { libelle: LIBELLES[colonne], ...valeurs },
          ])
        ),
      },
    });

    res.json({
      id: receptionId,
      corrections: Object.keys(diff).length,
      stock: { produit: reception.produit_nom, unite: reception.unite, quantite: stockApres },
      message:
        ecart === 0
          ? null
          : `Stock de ${reception.produit_nom} ajusté de ${ecart > 0 ? "+" : ""}${ecart} ` +
            `${reception.unite} : il est maintenant de ${stockApres} ${reception.unite}.`,
    });
  } catch (erreur) {
    await client.query("ROLLBACK");
    console.error("Erreur correction réception :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

module.exports = { corrigerReception, LIBELLES_RECEPTION: LIBELLES };
