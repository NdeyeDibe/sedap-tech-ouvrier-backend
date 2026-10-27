// Le verrou de paiement : où en est une bande impayée.
//
// Règle décidée par Mengué le 26 oct. 2026 :
//   - la facture est émise à l'ouverture de la bande ;
//   - le propriétaire a N heures pour payer (seuil paiement_delai_heures) ;
//   - passé ce délai, un AVERTISSEMENT s'affiche des deux côtés ;
//   - N heures plus tard, le POULAILLER se verrouille : l'interface du
//     propriétaire ne montre plus cette bande, et le responsable ne peut
//     plus saisir.
//
// CE QUI EST VERROUILLÉ, C'EST LE POULAILLER, PAS LE COMPTE.
// Un propriétaire de quatre poulaillers dont trois sont payés continue de
// suivre ces trois-là normalement (objection Ndeye, 26 oct. 2026 — elle
// avait raison, verrouiller le compte entier l'aurait puni pour ce qu'il
// a payé). Un responsable n'a de toute façon qu'un poulailler.
//
// CE QUE LE VERROU COÛTE, ET QUI EST ASSUMÉ.
// Pendant le verrou, le responsable ne saisit plus : les chiffres de ces
// jours-là se rattrapent ensuite depuis l'admin (saisie de journée
// oubliée, motif « compte suspendu »), mais les PHOTOS de mortalité, qui
// se prennent devant les sujets morts, sont perdues. Et aucune alerte ne
// part pendant ce temps. C'est un choix commercial assumé, pas un oubli.
//
// DEUX CAS NE DÉCLENCHENT JAMAIS LE VERROU :
//   - une facture sans montant (« sur devis », ou taille hors grille) :
//     on ne peut pas exiger le paiement d'une somme jamais communiquée.
//     Le délai part du jour où SEDAP fixe le prix ;
//   - une facture annulée.

const pool = require("../db/pool");
const { seuilsActuels } = require("./seuils");

const HEURE_MS = 60 * 60 * 1000;

/** Depuis quand le délai court pour cette facture. */
function departDuDelai(facture) {
  // Pour une facture chiffrée après coup, c'est le moment du chiffrage.
  const depart = facture.montant_fixe_le ?? facture.cree_le;
  return depart ? new Date(depart) : null;
}

/**
 * L'état de paiement d'une facture : rien, avertissement, ou verrou.
 *
 * @param facture  ligne `factures` + `paye` (somme des paiements)
 * @param seuils   valeurs courantes ; relues par l'appelant une seule fois
 */
function etatVerrou(facture, seuils = seuilsActuels()) {
  const etat = {
    etape: "a_jour",
    montant: facture.montant == null ? null : Number(facture.montant),
    reste: null,
    echeance: null,
    verrouilleLe: null,
    delaiAccorde: facture.delai_jusquau ? new Date(facture.delai_jusquau).toISOString() : null,
  };

  if (facture.annulee_le) return etat;
  if (facture.montant == null) {
    // Sur devis : rien à réclamer tant que le prix n'est pas fixé.
    etat.etape = "a_fixer";
    return etat;
  }

  const paye = Number(facture.paye ?? 0);
  etat.reste = Math.max(0, etat.montant - paye);
  if (etat.reste === 0) return etat;

  const depart = departDuDelai(facture);
  if (!depart) return etat;

  const echeance = new Date(depart.getTime() + Number(seuils.paiement_delai_heures) * HEURE_MS);
  const verrouilleLe = new Date(
    echeance.getTime() + Number(seuils.paiement_delai_avertissement_heures) * HEURE_MS
  );
  etat.echeance = echeance.toISOString();
  etat.verrouilleLe = verrouilleLe.toISOString();

  const maintenant = Date.now();

  // Un délai accordé par SEDAP repousse tout : ni avertissement, ni
  // verrou, tant qu'il court.
  if (facture.delai_jusquau && new Date(facture.delai_jusquau).getTime() > maintenant) {
    etat.etape = "delai_accorde";
    return etat;
  }

  if (maintenant >= verrouilleLe.getTime()) etat.etape = "verrouille";
  else if (maintenant >= echeance.getTime()) etat.etape = "avertissement";
  else etat.etape = "a_payer";

  return etat;
}

const REQUETE_FACTURES_POULAILLER = `
  SELECT fa.*, b.numero AS bande_numero, b.poulailler_id,
         pl.nom AS poulailler_nom, pl.ferme_id,
         COALESCE((SELECT sum(p.montant) FROM paiements p WHERE p.facture_id = fa.id), 0)::int AS paye
    FROM factures fa
    JOIN bandes b ON b.id = fa.bande_id
    JOIN poulaillers pl ON pl.id = b.poulailler_id
   WHERE b.poulailler_id = $1 AND fa.annulee_le IS NULL
   ORDER BY fa.cree_le`;

// De la plus grave à la plus anodine. Sert à choisir quelle facture
// l'écran doit montrer quand il y en a plusieurs en souffrance.
const GRAVITE = ["verrouille", "avertissement", "delai_accorde", "a_payer", "a_fixer", "a_jour"];

/**
 * L'état du verrou d'un poulailler.
 *
 * On regarde TOUTES ses factures non annulées, pas seulement la dernière.
 * Une première version ne prenait que la plus récente : une bande close
 * et jamais payée devenait alors invisible dès qu'une nouvelle bande
 * démarrait, et la dette disparaissait toute seule (défaut trouvé au
 * test, 27 oct. 2026).
 *
 * L'état retenu est le plus grave, et la facture renvoyée est celle qui
 * l'a provoqué — c'est elle que l'éleveur doit régler en premier.
 */
async function etatPoulailler(poulaillerId) {
  const { rows } = await pool.query(REQUETE_FACTURES_POULAILLER, [poulaillerId]);
  if (rows.length === 0) return { etape: "a_jour", facture: null };

  const seuils = seuilsActuels();
  const etats = rows.map((f) => ({ facture: f, etat: etatVerrou(f, seuils) }));

  etats.sort((a, b) => GRAVITE.indexOf(a.etat.etape) - GRAVITE.indexOf(b.etat.etape));
  const { facture, etat } = etats[0];

  return {
    ...etat,
    // Ce que la ferme doit en tout sur ce poulailler, toutes factures
    // confondues : l'éleveur doit voir sa dette entière, pas seulement
    // celle qui a déclenché le verrou.
    resteTotal: etats.reduce((t, e) => t + (e.etat.reste ?? 0), 0),
    facture: {
      id: facture.id,
      bandeId: facture.bande_id,
      bandeNumero: facture.bande_numero,
      poulaillerId: facture.poulailler_id,
      poulailler: facture.poulailler_nom,
      montant: facture.montant == null ? null : Number(facture.montant),
      paye: Number(facture.paye),
      effectif: facture.effectif,
      tranche: facture.tranche,
      pack: facture.pack || null,
    },
  };
}

/** Raccourci : ce poulailler est-il verrouillé en ce moment ? */
async function poulaillerVerrouille(poulaillerId) {
  const etat = await etatPoulailler(poulaillerId);
  return etat.etape === "verrouille";
}

module.exports = { etatVerrou, etatPoulailler, poulaillerVerrouille, departDuDelai };
