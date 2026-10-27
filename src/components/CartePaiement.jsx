import { Lock, Phone, TriangleAlert } from 'lucide-react'

/**
 * L'état de paiement d'un poulailler, sur sa carte d'accueil.
 *
 * Trois moments, trois tons :
 *  - « à payer » : la facture vient d'être émise, rien n'est bloqué ;
 *  - « avertissement » : le délai est dépassé, le poulailler sera
 *    suspendu à telle date — c'est le moment où tout doit être fait pour
 *    que l'éleveur paie, donc le message est précis et daté ;
 *  - « verrouillé » : le suivi de ce poulailler est fermé.
 *
 * Pourquoi dire la date et le montant exacts plutôt qu'un vague « votre
 * compte va être suspendu » : un éleveur qui ne sait ni combien ni quand
 * ne paie pas, il appelle. Et c'est SEDAP qui passe une demi-heure au
 * téléphone à lire des chiffres qu'un écran peut afficher.
 */

// Tant que l'encaissement en ligne n'est pas branché, le paiement se règle
// de la main à la main. Ce numéro est celui du support SEDAP ; il devra
// être remplacé par le numéro marchand le jour de l'intégration.
const NUMERO_SEDAP = '+221 77 167 87 66'

const francs = (v) =>
  v == null ? '—' : `${new Intl.NumberFormat('fr-FR').format(v)} F`

function jourEtHeure(iso) {
  if (!iso) return null
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

export default function CartePaiement({ paiement, compact = false }) {
  if (!paiement || paiement.etape === 'a_jour') return null

  const { etape, reste, bandeNumero, echeance, verrouilleLe, delaiAccorde } = paiement

  if (etape === 'delai_accorde') {
    return (
      <p className="mt-2.5 rounded-xl bg-surface px-3 py-2.5 text-[13.5px] text-encre-doux">
        Facture de {francs(reste)} en attente. SEDAP vous a accordé un délai
        {delaiAccorde ? ` jusqu'au ${jourEtHeure(delaiAccorde)}` : ''}.
      </p>
    )
  }

  if (etape === 'a_payer') {
    return (
      <p className="mt-2.5 rounded-xl bg-surface px-3 py-2.5 text-[13.5px]">
        <b>{francs(reste)}</b> à régler pour la bande n°{bandeNumero}
        {echeance ? `, avant le ${jourEtHeure(echeance)}` : ''}.
      </p>
    )
  }

  const verrouille = etape === 'verrouille'

  return (
    <div
      className={`mt-2.5 rounded-xl px-3.5 py-3 ${
        verrouille ? 'bg-urgent-voile' : 'bg-surveiller-voile'
      }`}
    >
      <p
        className={`flex items-center gap-2 text-[14.5px] font-bold ${
          verrouille ? 'text-urgent' : 'text-surveiller'
        }`}
      >
        {verrouille ? (
          <Lock size={17} strokeWidth={2} />
        ) : (
          <TriangleAlert size={17} strokeWidth={2} />
        )}
        {verrouille ? 'Suivi suspendu' : 'Paiement en retard'}
      </p>

      <p className="mt-1.5 text-[13.5px] leading-relaxed text-encre">
        {verrouille ? (
          <>
            Le suivi de ce poulailler est fermé jusqu'au règlement de{' '}
            <b>{francs(reste)}</b> (bande n°{bandeNumero}). Votre responsable ne
            peut plus faire ses saisies. Dès le paiement, tout reprend et les
            journées manquées sont rattrapées.
          </>
        ) : (
          <>
            <b>{francs(reste)}</b> à régler pour la bande n°{bandeNumero}.
            {verrouilleLe
              ? ` Sans paiement, le suivi de ce poulailler sera suspendu le ${jourEtHeure(verrouilleLe)}.`
              : ''}
          </>
        )}
      </p>

      {!compact && (
        <a
          href={`tel:${NUMERO_SEDAP.replace(/\s/g, '')}`}
          className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-vert text-[14.5px] font-semibold text-white"
        >
          <Phone size={17} strokeWidth={2} />
          Payer — appeler SEDAP
        </a>
      )}
    </div>
  )
}
