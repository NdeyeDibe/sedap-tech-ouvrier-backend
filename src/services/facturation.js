// La facture d'une bande, et ce qui a été encaissé dessus.
//
// Le prix vient de services/abonnement.js — ce fichier-ci ne décide
// d'aucun montant, il décide QUAND une facture existe et ce qu'il reste
// à payer.
//
// Règle de gratuité : une bande ouverte pendant les 4 mois gratuits est
// gratuite jusqu'à sa clôture (fiche d'offre, « La période gratuite »).
// C'est donc le jour d'OUVERTURE de la bande qui décide, jamais la date
// d'aujourd'hui : sinon une bande ouverte gratuitement deviendrait
// facturable le lendemain de la fin de la période.

const pool = require("../db/pool");
const { tarifPourBande, etatAbonnement, ecartEnJours, versJour } = require("./abonnement");
const { etatVerrou } = require("./verrou");

/** Cette ferme était-elle encore gratuite ce jour-là ? */
function gratuitAuJour(ferme, jour) {
  const etat = etatAbonnement(ferme);
  if (!etat.dernierJourGratuit) return false;
  return ecartEnJours(jour, etat.dernierJourGratuit) >= 0;
}

/**
 * Émet la facture d'une bande qui vient de s'ouvrir.
 *
 * Renvoie la facture créée, ou null si la bande est gratuite ou déjà
 * facturée. Ne lève pas pour un pack manquant : la facture est alors
 * créée sans montant, avec le motif — une ferme dont SEDAP a oublié de
 * renseigner le pack doit apparaître dans les impayés, pas disparaître.
 *
 * @param db   un client dans une transaction, ou le pool
 */
async function facturerOuverture(db, bandeId) {
  // L'abonnement se lit sur le POULAILLER depuis la migration 032 : un
  // propriétaire peut n'abonner qu'une partie de ses bâtiments, et à des
  // packs différents.
  const { rows } = await db.query(
    `SELECT b.id, b.date_debut, b.poussins_recus, b.morts_a_larrivee,
            pl.id AS poulailler_id, pl.pack, pl.abonnement_debut,
            f.id AS ferme_id
       FROM bandes b
       JOIN poulaillers pl ON pl.id = b.poulailler_id
       JOIN fermes f ON f.id = pl.ferme_id
      WHERE b.id = $1`,
    [bandeId]
  );
  const b = rows[0];
  // Un poulailler sans ferme (ceux hérités des tests) n'est rattaché à
  // aucun client : il n'y a personne à facturer.
  if (!b) return null;

  const jourOuverture = versJour(b.date_debut) ?? versJour(new Date());
  if (gratuitAuJour(b, jourOuverture)) return null;

  const { rows: dejaFacturee } = await db.query(
    "SELECT id FROM factures WHERE bande_id = $1",
    [bandeId]
  );
  if (dejaFacturee[0]) return null;

  // Le rang compte les factures de CE POULAILLER, pas de la ferme : la
  // caméra JARIN est installée dans un bâtiment précis, et c'est sur ses
  // dix premières bandes à lui qu'elle se paie.
  //
  // Le rang ne compte que les factures qui tiennent : une facture annulée
  // ne doit pas faire avancer le compteur.
  const { rows: compte } = await db.query(
    `SELECT count(*)::int AS n
       FROM factures fa
       JOIN bandes bb ON bb.id = fa.bande_id
      WHERE bb.poulailler_id = $1 AND fa.annulee_le IS NULL`,
    [b.poulailler_id]
  );
  const rang = compte[0].n + 1;

  const effectif = Math.max(0, Number(b.poussins_recus) - Number(b.morts_a_larrivee ?? 0));
  const tarif = tarifPourBande({ pack: b.pack, effectif, rang });

  const { rows: creees } = await db.query(
    `INSERT INTO factures
       (ferme_id, bande_id, pack, effectif, rang, tranche, montant, motif,
        camera_comprise, emise_le)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      b.ferme_id, bandeId, b.pack ?? "", effectif, rang, tarif.tranche,
      tarif.montant, tarif.motif, tarif.cameraComprise, jourOuverture,
    ]
  );
  return creees[0];
}

/**
 * Rattrapage : facture les bandes qui auraient dû l'être.
 *
 * Sert quand l'émission a échoué à l'ouverture (coupure, incident) ou
 * quand le pack d'une ferme a été renseigné après coup. Chaque bande est
 * traitée séparément : une qui échoue n'empêche pas les autres.
 */
async function facturerBandesOubliees(fermeId) {
  const { rows: bandes } = await pool.query(
    `SELECT b.id
       FROM bandes b
       JOIN poulaillers pl ON pl.id = b.poulailler_id
       LEFT JOIN factures fa ON fa.bande_id = b.id
      WHERE pl.ferme_id = $1 AND fa.id IS NULL
      ORDER BY b.date_debut`,
    [fermeId]
  );

  const creees = [];
  for (const b of bandes) {
    try {
      const facture = await facturerOuverture(pool, b.id);
      if (facture) creees.push(facture);
    } catch (erreur) {
      console.error(`Facture non émise pour la bande ${b.id} :`, erreur.message);
    }
  }
  return creees;
}

/** Les factures d'une ferme, avec ce qui a été encaissé sur chacune. */
async function facturesDeLaFerme(fermeId) {
  const { rows } = await pool.query(
    `SELECT fa.*,
            pl.nom AS poulailler, b.numero AS bande_numero, b.statut AS bande_statut,
            COALESCE((SELECT sum(p.montant) FROM paiements p WHERE p.facture_id = fa.id), 0)::int AS paye
       FROM factures fa
       JOIN bandes b ON b.id = fa.bande_id
       JOIN poulaillers pl ON pl.id = b.poulailler_id
      WHERE fa.ferme_id = $1
      ORDER BY fa.emise_le DESC, fa.id DESC`,
    [fermeId]
  );

  // Les encaissements de toutes ces factures en une seule requête : une
  // ferme de huit poulaillers en aligne vite une trentaine, et autant de
  // requêtes séparées se verraient à l'ouverture de la fiche.
  const { rows: paiements } = await pool.query(
    `SELECT p.id, p.facture_id, p.montant, p.moyen, p.reference, p.recu_le,
            a.prenom AS saisi_prenom, a.nom AS saisi_nom
       FROM paiements p
       JOIN factures fa ON fa.id = p.facture_id
       LEFT JOIN admins a ON a.id = p.saisi_par
      WHERE fa.ferme_id = $1
      ORDER BY p.recu_le, p.id`,
    [fermeId]
  );

  const parFacture = new Map();
  for (const p of paiements) {
    const liste = parFacture.get(p.facture_id) ?? [];
    liste.push({
      id: p.id,
      montant: Number(p.montant),
      moyen: p.moyen,
      reference: p.reference,
      recuLe: versJour(p.recu_le),
      saisiPar: [p.saisi_prenom, p.saisi_nom].filter(Boolean).join(" ") || null,
    });
    parFacture.set(p.facture_id, liste);
  }

  return rows.map((f) => ({ ...presenter(f), paiements: parFacture.get(f.id) ?? [] }));
}

/**
 * Les bandes qui DEVRAIENT avoir une facture et n'en ont pas.
 *
 * Les bandes ouvertes pendant la période gratuite sont exclues : elles
 * n'auront jamais de facture, et les compter afficherait à l'admin un
 * avertissement permanent sur une situation parfaitement normale.
 */
async function bandesSansFacture(fermeId) {
  const { rows } = await pool.query(
    `SELECT b.date_debut, pl.pack, pl.abonnement_debut
       FROM bandes b
       JOIN poulaillers pl ON pl.id = b.poulailler_id
       LEFT JOIN factures fa ON fa.bande_id = b.id
      WHERE pl.ferme_id = $1 AND fa.id IS NULL`,
    [fermeId]
  );
  return rows.filter((b) => !gratuitAuJour(b, versJour(b.date_debut) ?? versJour(new Date()))).length;
}

/**
 * L'état d'une facture, déduit de ses paiements — jamais stocké.
 *
 * « à fixer » est distinct de « impayée » : tant que SEDAP n'a pas mis de
 * montant, l'éleveur ne doit rien, il n'a simplement pas encore reçu son
 * prix. Les confondre ferait apparaître des dettes qui n'existent pas.
 */
function presenter(f) {
  const paye = Number(f.paye ?? 0);
  const montant = f.montant == null ? null : Number(f.montant);

  let statut;
  if (f.annulee_le) statut = "annulee";
  else if (montant == null) statut = "a_fixer";
  else if (paye >= montant) statut = "payee";
  else if (paye > 0) statut = "partielle";
  else statut = "impayee";

  // Où en est le verrou de paiement : l'admin doit voir « verrouillé »
  // ou « avertissement » sur la ligne, pas seulement « impayée ».
  const verrou = etatVerrou(f);

  return {
    verrou: {
      etape: verrou.etape,
      echeance: verrou.echeance,
      verrouilleLe: verrou.verrouilleLe,
      delaiAccorde: verrou.delaiAccorde,
    },
    id: f.id,
    bandeId: f.bande_id,
    bandeNumero: f.bande_numero,
    poulailler: f.poulailler,
    pack: f.pack || null,
    effectif: f.effectif,
    rang: f.rang,
    tranche: f.tranche,
    montant,
    motif: f.motif,
    cameraComprise: f.camera_comprise,
    emiseLe: versJour(f.emise_le),
    annuleeLe: f.annulee_le ? versJour(f.annulee_le) : null,
    paye,
    reste: montant == null ? null : Math.max(0, montant - paye),
    statut,
  };
}

module.exports = {
  gratuitAuJour,
  facturerOuverture,
  facturerBandesOubliees,
  facturesDeLaFerme,
  bandesSansFacture,
  presenter,
};
