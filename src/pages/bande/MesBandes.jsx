// Écran "Mes bandes" — historique des bandes du poulailler, reproduit
// fidèlement de la maquette Figma "Mes bandes.png".
//
// Règle CDC section III.3 : un seul poulailler = un seul responsable =
// une seule bande active à la fois. Le bouton "Nouvelle bande" doit donc
// être GRISÉ tant qu'une bande est en cours.
//
// Connecté au vrai backend (lib/bandesStore.js) — chargement asynchrone
// via useEffect, avec un état "chargement" le temps de la requête.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bird, ChevronRight } from "lucide-react";
import TopBar from "../../components/TopBar";
import { PrimaryButton } from "../../components/ui";
import { listerBandes, getBandeActive } from "../../lib/bandesStore";

export default function MesBandes() {
  const navigate = useNavigate();
  const [bandes, setBandes] = useState([]);
  const [bandeActive, setBandeActive] = useState(null);
  const [chargement, setChargement] = useState(true);

  useEffect(() => {
    chargerDonnees();
  }, []);

  async function chargerDonnees() {
    setChargement(true);
    const [listeBandes, active] = await Promise.all([listerBandes(), getBandeActive()]);
    setBandes(listeBandes);
    setBandeActive(active);
    setChargement(false);
  }

  function handlePlayAudio() {
    // TODO(audio) : guide vocal wolof de cet écran, pas encore enregistré
  }

  function handleClicBande(bande) {
    if (bande.statut === "en_cours") {
      navigate("/");
      return;
    }
    // Une bande terminée ouvre son historique. Rien n'est effacé à la
    // clôture : seule la vue manquait, et le responsable perdait de vue
    // son propre travail dès le lendemain de la dernière vente.
    navigate(`/historique?bande=${bande.id}`);
  }

  function handleNouvelleBande() {
    if (bandeActive) return;
    navigate("/bande/nouvelle");
  }

  if (chargement) {
    return (
      <div className="px-4 pb-6">
        <TopBar title="Mes bandes" onPlayAudio={handlePlayAudio} />
        <p className="text-center text-neutral-400 mt-16">Chargement...</p>
      </div>
    );
  }

  return (
    <div className="px-4 pb-6">
      <TopBar title="Mes bandes" showBack={bandes.length > 0} onPlayAudio={handlePlayAudio} />

      {bandes.length === 0 ? (
        <div className="flex flex-col items-center text-center mt-16 mb-10 px-4">
          <div className="w-20 h-20 rounded-full bg-neutral-100 flex items-center justify-center mb-4">
            <Bird size={36} className="text-neutral-400" strokeWidth={1.5} />
          </div>
          <h1 className="text-lg font-bold text-neutral-900 mb-1.5">Aucune bande pour l'instant</h1>
          <p className="text-sm text-neutral-400">Crée ta première bande pour commencer.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4 mt-4 mb-6">
          {bandes.map((bande) => {
            const enCours = bande.statut === "en_cours";
            return (
              <button
                key={bande.id}
                type="button"
                onClick={() => handleClicBande(bande)}
                className="flex items-center gap-3 rounded-2xl border border-neutral-100 shadow-sm bg-white px-4 py-4 text-left"
              >
                <span
                  className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
                    enCours ? "bg-sedap-clay-500" : "bg-neutral-100"
                  }`}
                >
                  <Bird size={20} className={enCours ? "text-white" : "text-neutral-400"} strokeWidth={2} />
                </span>

                <div className="flex-1 min-w-0">
                  <p className="font-bold text-neutral-900">Bande n°{bande.numero}</p>
                  <p className={`text-sm ${enCours ? "text-sedap-green-700 font-medium" : "text-neutral-400"}`}>
                    {enCours ? `Jour ${bande.jour} · en cours` : `${bande.jourTotal} jours · terminée`}
                  </p>
                </div>

                <span
                  className={`text-xs font-medium px-3 py-1.5 rounded-full shrink-0 ${
                    enCours ? "bg-sedap-green-50 text-sedap-green-700" : "bg-neutral-100 text-neutral-500"
                  }`}
                >
                  {enCours ? "En cours" : "Terminée"}
                </span>

                <ChevronRight size={18} className="text-neutral-300 shrink-0" />
              </button>
            );
          })}
        </div>
      )}

      <PrimaryButton disabled={!!bandeActive} onClick={handleNouvelleBande}>
        Nouvelle bande
      </PrimaryButton>
    </div>
  );
}