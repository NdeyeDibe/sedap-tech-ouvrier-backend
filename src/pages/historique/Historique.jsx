// Écran « Historique » — le responsable relit ses propres saisies.
//
// Jusqu'ici l'application ne montrait que la journée en cours. Dès le
// lendemain, impossible de vérifier ce qu'on avait déclaré, ni de
// retrouver le jour où tel produit avait été donné. Trois sections, une
// seule à la fois : mortalité, aliment distribué, produits utilisés.
//
// Les VENTES ne sont pas ici : elles ont déjà leur liste détaillée en bas
// de l'écran Vente, avec la date de chaque lot. Les dupliquer donnerait
// deux endroits à tenir à jour pour la même information.
//
// L'écran sert aussi aux bandes TERMINÉES, via ?bande=<id> depuis « Mes
// bandes ». Rien n'est effacé à la clôture d'une bande : seule la vue
// disparaissait, et le responsable perdait de vue son propre travail dès
// le lendemain de la vente.
import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Camera, AlertTriangle, Check } from "lucide-react";
import TopBar from "../../components/TopBar";
import { Card } from "../../components/ui";
import { getBandeActive, listerBandes } from "../../lib/bandesStore";
import {
  historiqueMortalite,
  historiqueAlimentation,
  historiqueProduitsUtilises,
  historiqueJours,
} from "../../lib/historiqueStore";

const SECTIONS = [
  { id: "mortalite", label: "Mortalité" },
  { id: "alimentation", label: "Aliment" },
  { id: "produits", label: "Produits" },
  { id: "jours", label: "Oublis" },
];

const NOMS_TYPES_ALIMENT = {
  demarrage: "Démarrage",
  croissance: "Croissance",
  finition: "Finition",
};

const CHARGEURS = {
  mortalite: historiqueMortalite,
  alimentation: historiqueAlimentation,
  produits: historiqueProduitsUtilises,
  jours: historiqueJours,
};

export default function Historique() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const section = SECTIONS.some((s) => s.id === params.get("section"))
    ? params.get("section")
    : "mortalite";

  // ?bande=<id> : une bande précise, terminée ou non. Sans ce paramètre,
  // c'est la bande en cours.
  const bandeDemandee = params.get("bande");

  const [bandeId, setBandeId] = useState(null);
  const [bande, setBande] = useState(null); // pour le sous-titre

  // Les données sont rangées PAR SECTION, pas dans une variable unique.
  // Avec une variable unique, le changement d'onglet peignait d'abord le
  // nouvel onglet avec les données de l'ancien — qui n'ont pas la même
  // forme — et l'écran plantait avant même que la requête parte. Ranger
  // par section supprime la cause, et offre en prime le retour instantané
  // sur un onglet déjà consulté.
  const [parSection, setParSection] = useState({});
  const [erreurs, setErreurs] = useState({});

  const donnees = parSection[section] ?? null; // null = pas encore chargé
  const erreur = erreurs[section] ?? "";

  useEffect(() => {
    let abandonne = false;

    // Une bande demandée explicitement : on la cherche dans la liste, qui
    // contient aussi les bandes terminées. On ne se contente pas de
    // l'identifiant de l'adresse — il faut son numéro pour le sous-titre,
    // et vérifier qu'elle appartient bien à ce responsable.
    const trouver = bandeDemandee
      ? listerBandes().then((liste) =>
          liste.find((b) => String(b.id) === String(bandeDemandee)) ?? null
        )
      : getBandeActive();

    trouver
      .then((b) => {
        if (abandonne) return;
        if (!b) {
          // Ni bande en cours, ni bande demandée reconnue : rien à relire.
          navigate(bandeDemandee ? "/bande" : "/", { replace: true });
          return;
        }
        setBandeId(b.id);
        setBande(b);
      })
      .catch(() => !abandonne && navigate("/", { replace: true }));

    return () => {
      abandonne = true;
    };
  }, [navigate, bandeDemandee]);

  // On ne télécharge que la section regardée, et une seule fois : revenir
  // sur un onglet déjà vu ne redemande rien au serveur.
  useEffect(() => {
    if (!bandeId) return;
    if (parSection[section] || erreurs[section]) return;
    let abandonne = false;
    CHARGEURS[section](bandeId)
      .then((d) => !abandonne && setParSection((p) => ({ ...p, [section]: d })))
      .catch(
        (e) =>
          !abandonne &&
          setErreurs((p) => ({ ...p, [section]: e.message || "Impossible de charger l'historique." }))
      );
    return () => {
      abandonne = true;
    };
    // parSection et erreurs ne sont volontairement pas dans les
    // dépendances : les y mettre relancerait l'effet à chaque réponse
    // reçue, donc en boucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bandeId, section]);

  // Vider l'erreur de la section suffit à relancer l'effet ci-dessus.
  function reessayer() {
    setErreurs((p) => {
      const suite = { ...p };
      delete suite[section];
      return suite;
    });
  }

  function handlePlayAudio() {
    // TODO(audio) : guide vocal wolof de cet écran, pas encore enregistré
  }

  return (
    <div className="px-4 pb-6">
      <TopBar title="Historique" onPlayAudio={handlePlayAudio} />

      {bande && (
        <p className="text-sm text-neutral-500 mb-3 -mt-1">
          Bande n° {bande.numero}
          {bande.statut === "terminee"
            ? ` · terminée${bande.jourTotal ? ` après ${bande.jourTotal} jours` : ""}`
            : ` · jour ${bande.jour}`}
        </p>
      )}

      <div className="flex gap-2 mb-4">
        {SECTIONS.map((s) => {
          const actif = s.id === section;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() =>
                setParams(
                  bandeDemandee ? { section: s.id, bande: bandeDemandee } : { section: s.id },
                  { replace: true }
                )
              }
              className={`flex-1 rounded-xl py-2.5 text-sm font-semibold transition-colors ${
                actif ? "bg-sedap-green-600 text-white" : "bg-neutral-100 text-neutral-500"
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {erreur && (
        <Card className="text-center py-6">
          <p className="text-sm text-neutral-500 mb-3">{erreur}</p>
          <button
            type="button"
            onClick={reessayer}
            className="text-sm font-semibold text-sedap-green-700 underline"
          >
            Réessayer
          </button>
        </Card>
      )}

      {!erreur && donnees === null && (
        <p className="text-center text-neutral-400 mt-10">Chargement…</p>
      )}

      {!erreur && donnees !== null && (
        <>
          {section === "mortalite" && <SectionMortalite donnees={donnees} />}
          {section === "alimentation" && <SectionAlimentation donnees={donnees} />}
          {section === "produits" && <SectionProduits donnees={donnees} />}
          {section === "jours" && <SectionJours donnees={donnees} />}
        </>
      )}
    </div>
  );
}

function SectionMortalite({ donnees }) {
  const lignes = donnees.lignes ?? [];
  const total = donnees.total ?? 0;
  if (lignes.length === 0) return <Vide texte="Aucune mortalité saisie pour l'instant." />;

  return (
    <>
      <Total valeur={`${total} sujet${total > 1 ? "s" : ""}`} legende="Morts depuis le début" />
      <Liste>
        {lignes.map((l) => (
          <Ligne
            key={l.date}
            jour={l.jour}
            date={l.date}
            // Le nombre de photos passe SOUS la date : à droite de la
            // date, il poussait la ligne au-delà de la largeur de
            // l'écran et coupait « 29 septembre » en deux.
            detail={
              l.nombrePhotos > 0 ? (
                <span className="flex items-center gap-1">
                  <Camera size={12} strokeWidth={2} />
                  {l.nombrePhotos} photo{l.nombrePhotos > 1 ? "s" : ""}
                </span>
              ) : null
            }
          >
            <p className="font-semibold text-neutral-900 shrink-0">
              {l.mortalite} sujet{l.mortalite > 1 ? "s" : ""}
            </p>
          </Ligne>
        ))}
      </Liste>
    </>
  );
}

function SectionAlimentation({ donnees }) {
  const lignes = donnees.lignes ?? [];
  const totalKg = donnees.totalKg ?? 0;
  if (lignes.length === 0) return <Vide texte="Aucun aliment distribué pour l'instant." />;

  return (
    <>
      <Total valeur={`${formaterKg(totalKg)} kg`} legende="Distribués depuis le début" />
      <Liste>
        {lignes.map((j) => (
          <Ligne
            key={j.date}
            jour={j.jour}
            date={j.date}
            detail={(j.lignes ?? [])
              .map((l) => `${NOMS_TYPES_ALIMENT[l.typeAliment] || l.typeAliment} ${formaterKg(l.kg)} kg`)
              .join(" · ")}
          >
            <p className="font-semibold text-neutral-900 shrink-0">{formaterKg(j.totalKg)} kg</p>
          </Ligne>
        ))}
      </Liste>
    </>
  );
}

function SectionProduits({ donnees }) {
  const lignes = donnees.lignes ?? [];
  if (lignes.length === 0) return <Vide texte="Aucun produit utilisé pour l'instant." />;

  return (
    <Liste>
      {lignes.map((j) => (
        <Ligne
          key={j.date}
          jour={j.jour}
          date={j.date}
          // Avec unité : « Vitamine C 12 doses ». Sans unité (catégorie
          // « Autre »), le « × » évite de lire « Désinfectant local 2 »
          // comme s'il s'agissait d'un nom de produit.
          detail={(j.produits ?? [])
            .map((p) =>
              p.unite
                ? `${p.nom} ${formaterKg(p.quantite)} ${p.unite}`
                : `${p.nom} × ${formaterKg(p.quantite)}`
            )
            .join(" · ")}
        />
      ))}
    </Liste>
  );
}

// Les journées oubliées. On montre d'abord ce qui manque — c'est ce que
// le responsable vient chercher — puis, repliées en dessous, les journées
// complètes, pour qu'il voie que le reste est en ordre.
function SectionJours({ donnees }) {
  const lignes = donnees.lignes ?? [];
  const manquants = donnees.manquants ?? [];
  const nombre = donnees.nombreManquants ?? manquants.length;

  if (lignes.length === 0) return <Vide texte="La bande vient de démarrer." />;

  if (nombre === 0) {
    return (
      <Card className="text-center py-8">
        <div className="w-14 h-14 rounded-full bg-sedap-green-50 flex items-center justify-center mx-auto mb-3">
          <Check size={30} className="text-sedap-green-600" strokeWidth={2.5} />
        </div>
        <p className="font-semibold text-neutral-900">Aucun jour oublié</p>
        <p className="text-sm text-neutral-500 mt-1">
          Les {lignes.length} jours de la bande sont saisis.
        </p>
      </Card>
    );
  }

  return (
    <>
      <Card className="text-center py-5 mb-3">
        <p className="text-2xl font-bold text-purple-600">
          {nombre} jour{nombre > 1 ? "s" : ""}
        </p>
        <p className="text-xs text-neutral-400 mt-1">
          Saisie incomplète · sur {lignes.length} jours
        </p>
      </Card>

      <Liste>
        {manquants.map((j) => (
          <Ligne
            key={j.date}
            jour={j.jour}
            date={j.date}
            detail={`Manque : ${j.manques.join(", ")}`}
          >
            <AlertTriangle size={18} className="text-purple-500 shrink-0 mt-0.5" strokeWidth={2} />
          </Ligne>
        ))}
      </Liste>

      {/* La journée du jour n'est jamais comptée comme oubliée : elle
          n'est pas finie. On le dit, sinon le responsable cherche
          pourquoi elle n'apparaît pas. Sur une bande terminée il n'y a
          plus de journée en cours : la note n'aurait aucun sens. */}
      {lignes.some((l) => l.etatSaisie === "en_cours") && (
        <p className="text-xs text-neutral-400 text-center mt-3">
          La journée en cours n'est pas comptée.
        </p>
      )}
    </>
  );
}

function Total({ valeur, legende }) {
  return (
    <Card className="text-center py-5 mb-3">
      <p className="text-2xl font-bold text-sedap-green-700">{valeur}</p>
      <p className="text-xs text-neutral-400 mt-1">{legende}</p>
    </Card>
  );
}

function Liste({ children }) {
  return <Card className="divide-y divide-neutral-100 p-0 overflow-hidden">{children}</Card>;
}

// Une journée. Le numéro de jour vient en premier : c'est ainsi que le
// responsable se repère (« le jour du vaccin », « J21 »), la date du
// calendrier ne sert qu'à confirmer.
function Ligne({ jour, date, detail, children }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="font-semibold text-neutral-900 whitespace-nowrap">
          Jour {jour} <span className="font-normal text-neutral-400">· {dateCourte(date)}</span>
        </p>
        {detail && <p className="text-xs text-neutral-500 mt-0.5">{detail}</p>}
      </div>
      {children}
    </div>
  );
}

function Vide({ texte }) {
  return (
    <Card className="text-center py-8">
      <p className="text-sm text-neutral-500">{texte}</p>
    </Card>
  );
}

// « 4 août ». L'année n'apparaît que si la saisie ne date pas de l'année
// en cours — une bande dure six semaines, l'année est du bruit.
function dateCourte(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const options = { day: "numeric", month: "long" };
  if (d.getFullYear() !== new Date().getFullYear()) options.year = "numeric";
  return d.toLocaleDateString("fr-FR", options);
}

// Les quantités arrivent en NUMERIC : « 160 » plutôt que « 160.00 », mais
// on garde les décimales quand il y en a vraiment (2,5 kg).
function formaterKg(valeur) {
  const n = Number(valeur);
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "").replace(".", ",");
}
