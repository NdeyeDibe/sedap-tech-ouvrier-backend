const pool = require("../db/pool");
const { alertesDeLaFerme } = require("../services/alertesFerme");
const { pushActif, notifierProprietaire } = require("../services/notificationsPush");

// Tâches automatiques du serveur, lancées au démarrage par server.js.
//
//  1. Toutes les 15 minutes : annonce les réceptions de stock déclarées par
//     l'ouvrier, puis recalcule les alertes de chaque propriétaire abonné aux
//     notifications et envoie celles qui sont nouvelles.
//  2. Une fois par jour : supprime les vocaux des bandes clôturées depuis
//     plus d'un mois (les photos, elles, sont gardées pour entraîner l'IA).

const QUINZE_MINUTES = 15 * 60 * 1000;
const UN_JOUR = 24 * 3600 * 1000;

// Préférence de l'écran Profil qui gouverne chaque type d'alerte.
// Les types absents (aliment, pesage, saisie) sont toujours envoyés.
const PREFERENCE_PAR_TYPE = {
  mortalite: "mortalite",
  vaccination: "vaccination",
};

// ---------------------------------------------------------- réceptions

// Le propriétaire est prévenu de CHAQUE réception, même payée par l'ouvrier :
// c'est ce qui lui permet de recouper ce qu'il a commandé, ce que le
// fournisseur a livré et ce qui a été déclaré dans l'appli. Un écart de deux
// ou trois sacs ne se voit que comme ça.
const REQUETE_RECEPTIONS_NOUVELLES = `
  SELECT r.origine, r.id, r.nom, r.unite, r.quantite, r.prix_unitaire,
         r.source, r.date_reception,
         pl.id AS poulailler_id, pl.nom AS poulailler_nom,
         f.proprietaire_id
    FROM receptions_ferme r
    JOIN poulaillers pl ON pl.id = r.poulailler_id
    JOIN fermes f ON f.id = pl.ferme_id
   WHERE r.date_reception > now() - interval '7 days'
     AND EXISTS (SELECT 1 FROM abonnements_push ap
                  WHERE ap.proprietaire_id = f.proprietaire_id)
     AND NOT EXISTS (SELECT 1 FROM receptions_notifiees rn
                      WHERE rn.origine = r.origine
                        AND rn.reception_id = r.id
                        AND rn.proprietaire_id = f.proprietaire_id)
   ORDER BY r.date_reception
`;

const nombre = (valeur) => Number(valeur).toLocaleString("fr-FR");

function texteReception(r) {
  const paye =
    r.source === "proprietaire"
      ? "payé par vous — prix à renseigner"
      : `payé par l'ouvrier${
          r.prix_unitaire === null
            ? ""
            : ` · ${nombre(Number(r.quantite) * Number(r.prix_unitaire))} Fcfa`
        }`;

  return `${nombre(r.quantite)} ${r.unite} de ${r.nom} · ${paye}`;
}

async function annoncerReceptions() {
  if (!pushActif) return;

  const { rows } = await pool.query(REQUETE_RECEPTIONS_NOUVELLES);
  if (rows.length === 0) return;

  // Regroupées par propriétaire : une livraison de plusieurs produits le même
  // jour ne doit pas faire vibrer le téléphone cinq fois.
  const parProprietaire = new Map();

  for (const r of rows) {
    const { rowCount } = await pool.query(
      `INSERT INTO receptions_notifiees (origine, reception_id, proprietaire_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [r.origine, r.id, r.proprietaire_id]
    );
    if (rowCount === 0) continue;

    const liste = parProprietaire.get(r.proprietaire_id) ?? [];
    liste.push(r);
    parProprietaire.set(r.proprietaire_id, liste);
  }

  for (const [proprietaireId, receptions] of parProprietaire) {
    if (receptions.length === 1) {
      const r = receptions[0];
      await notifierProprietaire(proprietaireId, {
        titre: `📦 Réception — ${r.poulailler_nom}`,
        corps: texteReception(r),
        url: `/poulailler/${r.poulailler_id}/receptions`,
        tag: `reception-${r.origine}-${r.id}`,
      });
      continue;
    }

    const aChiffrer = receptions.filter((r) => r.prix_unitaire === null).length;
    await notifierProprietaire(proprietaireId, {
      titre: `📦 ${receptions.length} réceptions de stock`,
      corps: receptions
        .slice(0, 3)
        .map((r) => `${nombre(r.quantite)} ${r.unite} de ${r.nom}`)
        .join(", ")
        .concat(
          receptions.length > 3 ? `, et ${receptions.length - 3} autres` : "",
          aChiffrer > 0 ? ` · ${aChiffrer} sans prix` : ""
        ),
      url: `/poulailler/${receptions[0].poulailler_id}/receptions`,
    });
  }
}

// ------------------------------------------------------------ alertes

async function envoyerNouvellesAlertes() {
  if (!pushActif) return;

  const { rows: proprietaires } = await pool.query(
    "SELECT DISTINCT proprietaire_id FROM abonnements_push"
  );

  for (const { proprietaire_id: proprietaireId } of proprietaires) {
    const alertes = await alertesDeLaFerme(proprietaireId);
    const nouvelles = [];

    for (const alerte of alertes) {
      // Le journal refuse un doublon (même alerte, même niveau, même jour) :
      // si l'insertion passe, c'est que l'alerte n'a pas encore été envoyée.
      const { rowCount } = await pool.query(
        `INSERT INTO alertes_notifiees
           (proprietaire_id, bande_id, type, cle, niveau)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [proprietaireId, alerte.bandeId, alerte.type, alerte.cle, alerte.niveau]
      );
      if (rowCount > 0) nouvelles.push(alerte);
    }

    if (nouvelles.length === 0) continue;

    // Une notification par alerte, sauf avalanche : au-delà de 3, un seul
    // message récapitulatif, pour ne pas faire vibrer le téléphone en boucle.
    if (nouvelles.length > 3) {
      const urgentes = nouvelles.filter((a) => a.niveau === "urgent").length;
      await notifierProprietaire(proprietaireId, {
        titre: `${nouvelles.length} nouvelles alertes`,
        corps: urgentes
          ? `Dont ${urgentes} urgente${urgentes > 1 ? "s" : ""}. Touchez pour voir.`
          : "Touchez pour voir le détail.",
        url: "/alertes",
        badge: alertes.length,
      });
      continue;
    }

    for (const alerte of nouvelles) {
      await notifierProprietaire(
        proprietaireId,
        {
          titre: `${alerte.niveau === "urgent" ? "🔴" : "🟠"} ${alerte.titre} — ${
            alerte.poulailler.nom ?? "Poulailler"
          }`,
          corps: alerte.message,
          url: `/poulailler/${alerte.poulailler.id}`,
          tag: `${alerte.bandeId}-${alerte.type}`,
          badge: alertes.length,
        },
        PREFERENCE_PAR_TYPE[alerte.type] ?? null
      );
    }
  }

  // Le journal n'a pas besoin de garder plus d'un mois d'historique.
  await pool.query(
    "DELETE FROM alertes_notifiees WHERE jour < current_date - 30"
  );
}

// ------------------------------------------------------------ vocaux

// L'identifiant Cloudinary d'un fichier se lit dans son adresse :
// .../video/upload/v1726000000/dossier/vocal-123.webm → dossier/vocal-123
function identifiantCloudinary(url) {
  const apres = url.split("/upload/")[1];
  if (!apres) return null;
  return apres.replace(/^v\d+\//, "").replace(/\.[^/.]+$/, "");
}

async function supprimerVieuxVocaux() {
  const { CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    console.warn("⚠️  Nettoyage des vocaux désactivé : clés Cloudinary absentes.");
    return;
  }

  const cloudinary = require("cloudinary").v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "yrupel1v",
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
  });

  const { rows } = await pool.query(
    `SELECT ss.id, ss.vocal_url
       FROM saisies_sante ss
       JOIN bandes b ON b.id = ss.bande_id
      WHERE ss.vocal_url IS NOT NULL
        AND b.statut = 'terminee'
        AND b.date_fin < now() - interval '1 month'`
  );

  let supprimes = 0;

  for (const { id, vocal_url: url } of rows) {
    const identifiant = identifiantCloudinary(url);
    try {
      if (identifiant) {
        // Les fichiers audio sont rangés par Cloudinary sous « video ».
        await cloudinary.uploader.destroy(identifiant, {
          resource_type: "video",
          invalidate: true,
        });
      }
      // a_vocal reste vrai : l'historique montre qu'un vocal a existé.
      await pool.query(
        "UPDATE saisies_sante SET vocal_url = NULL WHERE id = $1",
        [id]
      );
      supprimes += 1;
    } catch (erreur) {
      console.error(`Vocal ${id} non supprimé :`, erreur.message);
    }
  }

  if (supprimes > 0) console.log(`🧹 ${supprimes} vocal(aux) supprimé(s).`);
}

// ------------------------------------------------------------ lancement

// Une tâche qui plante ne doit ni arrêter le serveur, ni les autres tâches.
function repeter(nom, tache, intervalle, delaiInitial) {
  const executer = () =>
    tache().catch((erreur) => console.error(`Erreur ${nom} :`, erreur));

  setTimeout(() => {
    executer();
    setInterval(executer, intervalle);
  }, delaiInitial);
}

async function passageSurveillance() {
  // Les réceptions d'abord : le propriétaire voit l'événement avant
  // l'alerte « réception à chiffrer » qui en découle.
  await annoncerReceptions();
  await envoyerNouvellesAlertes();
}

function demarrerSurveillance() {
  repeter("surveillance", passageSurveillance, QUINZE_MINUTES, 30 * 1000);
  repeter("nettoyage des vocaux", supprimerVieuxVocaux, UN_JOUR, 60 * 1000);
  console.log("⏱️  Surveillance automatique démarrée.");
}

module.exports = {
  demarrerSurveillance,
  annoncerReceptions,
  envoyerNouvellesAlertes,
  supprimerVieuxVocaux,
  identifiantCloudinary,
};
