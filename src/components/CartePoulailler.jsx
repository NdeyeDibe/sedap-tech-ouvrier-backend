import { Link } from 'react-router-dom'
import { ChevronRight, Info, Warehouse } from 'lucide-react'
import StatutBadge from './StatutBadge.jsx'
import CartePaiement from './CartePaiement.jsx'

const TEINTE_ALERTE = {
  surveiller: 'text-surveiller',
  urgent: 'text-urgent',
}

const LIBELLE_PHASE = {
  en_cours: 'En cours',
  en_vente: 'En vente',
  terminee: 'Terminée',
}

function Puce({ children, className = '' }) {
  return (
    <span
      className={`rounded-lg px-2.5 py-1 text-[12.5px] font-medium ${className}`}
    >
      {children}
    </span>
  )
}

export default function CartePoulailler({ poulailler }) {
  const bande = poulailler.bandeActive
  const paiement = poulailler.paiement
  // Poulailler suspendu pour facture impayée : on retire les chiffres de
  // la carte. C'est tout l'objet du verrou — le suivi est la marchandise,
  // et elle n'est pas payée. Le nom du poulailler et la facture restent,
  // sinon l'éleveur ne saurait même pas quoi régler.
  const suspendu = paiement?.etape === 'verrouille'

  // La card n'annonce que l'alerte la plus grave — le détail est sur
  // l'onglet Alertes.
  const [alerte] = poulailler.alertes ?? []

  return (
    <article className="rounded-2xl bg-white p-3.5 shadow-[0_2px_12px_rgba(0,18,1,0.05)]">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface">
          <Warehouse size={18} strokeWidth={1.8} />
        </span>

        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-bold leading-tight">
            {poulailler.nom ?? 'Poulailler'}
          </h2>

          <p className="flex items-center gap-1.5 text-[13px] text-encre-doux">
            {bande ? (
              <span>
                Bande n°{bande.numero} - J{bande.ageJours}
              </span>
            ) : (
              <span>Aucune bande en cours</span>
            )}

            {/* La phase de vente change ce que le propriétaire doit surveiller */}
            {bande?.statut === 'en_vente' && (
              <span className="rounded-full bg-surveiller-voile px-2 py-0.5 text-[11px] font-medium text-surveiller">
                {LIBELLE_PHASE.en_vente}
              </span>
            )}
          </p>
        </div>

        <StatutBadge niveau={poulailler.statut} />
      </div>

      {bande && !suspendu && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {poulailler.ouvrier && (
            <Puce className="bg-surface text-encre-moyen">
              {poulailler.ouvrier.nom}
            </Puce>
          )}
          <Puce className="bg-vert-voile text-vert-texte">
            {bande.restant} vivants
          </Puce>
          <Puce className="bg-urgent-voile text-urgent">
            {String(bande.morts).padStart(2, '0')} Morts
          </Puce>

          {/* Ramassés et vendus ne s'équivalent pas : les premiers attendent
              encore leur prix. */}
          {bande.ramasses > 0 && (
            <Puce className="bg-surveiller-voile text-surveiller">
              {bande.ramasses} ramassés
            </Puce>
          )}
          {bande.vendusFerme > 0 && (
            <Puce className="bg-surface text-encre-moyen">
              {bande.vendusFerme} vendus
            </Puce>
          )}
        </div>
      )}

      <CartePaiement paiement={paiement} />

      {alerte && !suspendu && (
        <p
          className={`mt-2.5 flex items-center gap-2 text-[14px] ${TEINTE_ALERTE[alerte.niveau]}`}
        >
          <Info size={16} strokeWidth={2} className="shrink-0" />
          {alerte.message}
        </p>
      )}

      {/* Pas de lien vers le détail quand c'est suspendu : il n'y aurait
          rien à y voir, et un écran vide ressemblerait à un bogue. */}
      {!suspendu && (
        <Link
          to={`/poulailler/${poulailler.id}`}
          className="mt-2.5 flex items-center justify-between border-t border-bord pt-2.5 text-[15px] font-medium"
        >
          Voir détail
          <ChevronRight size={18} className="text-encre-doux" />
        </Link>
      )}
    </article>
  )
}
