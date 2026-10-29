import { useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { CalendarDays, PackageCheck } from 'lucide-react'
import {
  formaterFcfa,
  renseignerPrix,
  useRegistreReceptions,
} from '../../data/receptionsStore.js'
import EnteteEcran from '../../components/EnteteEcran.jsx'
import {
  BoutonEnregistrer,
  Champ,
  ChampSelect,
} from '../../components/Champ.jsx'
import { Chargement, Echec } from '../../components/EtatChargement.jsx'

// Couvoirs proposés pour des poussins payés par le propriétaire : même liste
// que l'écran « Nouvelle bande » de l'appli ouvrier.
const COUVOIRS = [
  'Zalar', 'Sedima', 'Aviboy', 'Avifrique', 'APRAN', 'Couvoir AMAR',
  'JAI LAXMI', 'AVIA', 'PRODAS', 'AVITECH', 'Autre',
]

// Au-delà, la liste est repliée : une bande longue accumule les livraisons.
const APERCU = 6

const dateCourte = (iso) =>
  new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
  })

// Le serveur décide seul s'il faut préfixer le nom par sa famille : lui
// seul connaît le catalogue de stock, donc lui seul sait que « Pot 1 kg »
// existe à la fois en Vitamines et en Antistress, alors que « Croissance »
// ou « Balle de riz » se suffisent (voir NOMS_AMBIGUS côté serveur).
//
// Le repli sur `nom` sert aux versions de l'API antérieures au 29 oct. 2026.
const intitule = (r) => r.nomAffiche ?? r.nom

// Les quantités peuvent être fractionnaires (un demi-sac, un flacon
// entamé) : les arrondir à l'entier afficherait « 0 » pour une réception
// bien réelle.
const nombreLisible = (n) =>
  new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(n)

// Une quantité absente ou nulle n'est pas « zéro reçu » : c'est une
// donnée manquante. L'écrire « 0 unités » ferait croire au propriétaire
// qu'il n'a rien reçu, alors qu'il a une facture en main.
const quantite = (r) =>
  Number(r.quantite) > 0
    ? `${nombreLisible(Number(r.quantite))} ${r.unite}`
    : 'quantité à vérifier'

function LigneReception({ reception, onChiffrer }) {
  const parLeProprietaire = reception.payePar === 'proprietaire'

  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium">
            {intitule(reception)}
            {reception.origine === 'poussins' &&
              reception.bandeNumero &&
              ` · Bande n°${reception.bandeNumero}`}
          </p>
          <p className="text-[13px] text-encre-doux">
            {quantite(reception)} · {dateCourte(reception.date)}
            {reception.provenance && ` · ${reception.provenance}`}
          </p>
        </div>

        {reception.prixManquant ? (
          <button
            type="button"
            onClick={() => onChiffrer(reception)}
            className="shrink-0 rounded-lg bg-surveiller-voile px-3 py-2 text-[13px] font-medium text-surveiller"
          >
            Renseigner le prix
          </button>
        ) : (
          <span className="shrink-0 text-[16px] font-bold">
            {formaterFcfa(reception.montant)}
          </span>
        )}
      </div>

      <p className="mt-1 text-[12px] text-encre-doux">
        {parLeProprietaire ? 'Payé par vous' : 'Payé par le responsable'}
        {reception.bandeNumero
          ? ` · Bande n°${reception.bandeNumero}`
          : ' · hors bande'}
      </p>
    </li>
  )
}

function Groupe({ titre, resume, receptions, onChiffrer }) {
  const [tout, setTout] = useState(false)

  if (receptions.length === 0) return null

  const visibles = tout ? receptions : receptions.slice(0, APERCU)

  return (
    <section className="overflow-hidden rounded-2xl bg-surface">
      <header className="flex items-center justify-between gap-3 px-4 py-3">
        <h2 className="text-[16px] font-semibold">{titre}</h2>
        <span className="shrink-0 text-[14px] text-encre-moyen">{resume}</span>
      </header>

      <ul className="divide-y divide-bord bg-white">
        {visibles.map((r) => (
          <LigneReception
            key={`${r.origine}-${r.id}`}
            reception={r}
            onChiffrer={onChiffrer}
          />
        ))}

        {receptions.length > APERCU && (
          <li>
            <button
              type="button"
              onClick={() => setTout((v) => !v)}
              className="w-full px-4 py-3 text-[14px] font-medium text-vert-texte"
            >
              {tout ? 'Réduire' : `Voir tout (${receptions.length})`}
            </button>
          </li>
        )}
      </ul>
    </section>
  )
}

/** Saisie du prix d'une réception, sous la ligne concernée. */
function FormulairePrix({ reception, onFerme }) {
  const [prix, setPrix] = useState('')
  // Poussins : le propriétaire donne aussi le couvoir (vide si c'est lui qui
  // les a payés ; déjà rempli pour une ancienne bande).
  const poussins = reception.origine === 'poussins'
  const [provenance, setProvenance] = useState(reception.provenance ?? '')
  const [envoi, setEnvoi] = useState(false)
  const [echec, setEchec] = useState('')

  const valeur = Number(prix)
  const complet = valeur > 0 && (!poussins || provenance !== '')

  async function enregistrer(evenement) {
    evenement.preventDefault()
    if (!complet) return

    setEnvoi(true)
    setEchec('')

    try {
      await renseignerPrix(
        reception.origine,
        reception.id,
        valeur,
        poussins ? provenance : undefined
      )
      onFerme()
    } catch (e) {
      setEchec(e.message)
    } finally {
      setEnvoi(false)
    }
  }

  return (
    <form
      onSubmit={enregistrer}
      className="space-y-3 rounded-2xl bg-white p-4 shadow-[0_2px_12px_rgba(0,18,1,0.05)]"
    >
      <div>
        <h2 className="text-[16px] font-semibold">{intitule(reception)}</h2>
        <p className="mt-1 text-[14px] text-encre-doux">
          {quantite(reception)} reçus le {dateCourte(reception.date)}
        </p>
      </div>

      {poussins && (
        <ChampSelect
          label="Provenance"
          value={provenance}
          onChange={(evenement) => setProvenance(evenement.target.value)}
          options={[
            { valeur: '', libelle: 'Provenance (couvoir)' },
            // Une ancienne bande peut porter un couvoir hors liste.
            ...(provenance && !COUVOIRS.includes(provenance)
              ? [{ valeur: provenance, libelle: provenance }]
              : []),
            ...COUVOIRS.map((c) => ({ valeur: c, libelle: c })),
          ]}
        />
      )}

      {/* L'aliment se chiffre au sac (« Fcfa / sac de 50 kg ») : le serveur
          reconvertit en prix du kg. Repli sur l'unité pour un ancien serveur. */}
      <Champ
        label={`Prix unitaire (Fcfa / ${reception.unitePrix ?? reception.unite})`}
        value={prix}
        onChange={(evenement) => setPrix(evenement.target.value)}
        type="number"
        inputMode="numeric"
        min="1"
        autoFocus
      />

      {valeur > 0 && (
        <p className="text-[14px] text-encre-moyen">
          Total : {formaterFcfa(valeur * reception.quantite)}
        </p>
      )}

      {echec && <p className="text-[14px] text-urgent">{echec}</p>}

      <div className="flex gap-2.5 pt-1">
        <button
          type="button"
          onClick={onFerme}
          className="flex-1 rounded-xl bg-[#EAEBEA] py-3.5 text-[16px] font-medium text-[#757F75]"
        >
          Annuler
        </button>

        <div className="flex-1">
          <BoutonEnregistrer disabled={!complet || envoi}>
            {envoi ? 'Enregistrement…' : 'Enregistrer'}
          </BoutonEnregistrer>
        </div>
      </div>
    </form>
  )
}

export default function ReceptionsPoulailler() {
  const { poulaillerId } = useParams()
  const [parametres] = useSearchParams()
  const bandeId = parametres.get('bande')

  const { donnees, chargement, erreur } = useRegistreReceptions(
    poulaillerId,
    bandeId
  )
  const [aChiffrer, setAChiffrer] = useState(null)

  if (chargement) return <Chargement />
  if (erreur) return <Echec erreur={erreur} />

  const receptions = donnees.receptions
  const sansPrix = receptions.filter((r) => r.prixManquant)
  const chiffrees = receptions.filter((r) => !r.prixManquant)

  return (
    <div className="pb-10">
      <EnteteEcran titre="Réceptions de stock" />

      <div className="space-y-5 px-4">
        <div className="entete-vert flex rounded-2xl px-5 py-4 text-white">
          <div className="flex-1 pr-3">
            <p className="text-[20px] font-bold leading-none">
              {donnees.totaux.nombre}
            </p>
            <p className="mt-1.5 text-[13px] text-white/80">Réceptions</p>
          </div>

          <span className="w-px self-stretch bg-white/25" />

          <div className="flex-1 pl-3">
            <p className="text-[20px] font-bold leading-none">
              {formaterFcfa(donnees.totaux.depenseConnue)}
            </p>
            <p className="mt-1.5 text-[13px] text-white/80">Dépense connue</p>
          </div>
        </div>

        {/* Ce que l'ouvrier a déclaré est à recouper avec ce qui a été
            commandé : 100 sacs commandés, 97 livrés, 98 déclarés se voient ici. */}
        <p className="flex items-start gap-2.5 rounded-2xl bg-vert-voile px-4 py-3 text-[14px] leading-relaxed text-vert-texte">
          <PackageCheck size={18} strokeWidth={1.8} className="mt-px shrink-0" />
          Vérifiez que les quantités déclarées correspondent à ce que vous avez
          commandé.
        </p>

        {aChiffrer && (
          <FormulairePrix
            reception={aChiffrer}
            onFerme={() => setAChiffrer(null)}
          />
        )}

        <Groupe
          titre="À chiffrer"
          resume={`${sansPrix.length} sans prix`}
          receptions={sansPrix}
          onChiffrer={setAChiffrer}
        />

        <Groupe
          titre="Réceptions enregistrées"
          resume={formaterFcfa(donnees.totaux.depenseConnue)}
          receptions={chiffrees}
          onChiffrer={setAChiffrer}
        />

        {receptions.length === 0 && (
          <p className="flex items-center gap-2.5 px-1 text-[15px] text-encre-doux">
            <CalendarDays size={18} strokeWidth={1.8} className="shrink-0" />
            Aucune réception de stock enregistrée pour ce poulailler.
          </p>
        )}
      </div>
    </div>
  )
}
