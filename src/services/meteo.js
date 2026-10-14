// Prévisions de température, pour l'alerte chaleur.
//
// Source : Open-Meteo (api.open-meteo.com). Gratuit, sans clé, sans
// compte — c'est la raison de ce choix : pas une facture de plus, pas un
// secret de plus à faire tourner. En échange, aucun engagement de
// service : tout ici doit survivre à une absence de réponse.
//
// Ce que le service ne fait PAS : deviner la température à l'intérieur du
// poulailler. Il donne l'extérieur, à l'échelle de la commune. Les
// messages d'alerte le disent, et ne prétendent rien d'autre.
//
// Rythme : une fois par jour, pour toutes les fermes qui ont des
// coordonnées. Les prévisions sont rangées en base et c'est elles que
// lisent les alertes — trois interfaces les consultent en boucle, il
// n'est pas question d'appeler le service à chaque affichage.
const pool = require("../db/pool");

const RACINE = "https://api.open-meteo.com/v1/forecast";

// Au-delà, on considère que le service ne répondra pas : mieux vaut un
// job qui se termine sans prévision qu'un job qui reste accroché.
const DELAI_MS = 15000;

/**
 * Interroge Open-Meteo pour un point, et renvoie
 * [{ jour, tmax, tmin }] — aujourd'hui et demain.
 *
 * Lève une erreur en cas de réponse illisible : l'appelant décide quoi
 * en faire (ici : journaliser et passer à la ferme suivante).
 */
async function previsionPour(latitude, longitude) {
  const url =
    `${RACINE}?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}` +
    `&daily=temperature_2m_max,temperature_2m_min&timezone=Africa%2FDakar&forecast_days=2`;

  const signal = AbortSignal.timeout(DELAI_MS);
  const reponse = await fetch(url, { signal });
  if (!reponse.ok) {
    throw new Error(`Open-Meteo a répondu ${reponse.status}`);
  }

  const donnees = await reponse.json();
  const jours = donnees?.daily?.time;
  const maxima = donnees?.daily?.temperature_2m_max;
  const minima = donnees?.daily?.temperature_2m_min;

  // Lecture défensive : si la forme change, on refuse proprement au lieu
  // d'écrire des NULL un peu partout.
  if (!Array.isArray(jours) || !Array.isArray(maxima) || jours.length === 0) {
    throw new Error("Réponse d'Open-Meteo inattendue");
  }

  return jours.map((jour, i) => ({
    jour,
    tmax: Number.isFinite(maxima?.[i]) ? maxima[i] : null,
    tmin: Number.isFinite(minima?.[i]) ? minima[i] : null,
  }));
}

/**
 * Rafraîchit les prévisions de toutes les fermes localisées.
 *
 * Renvoie un compte-rendu lisible — il sert au journal du serveur, et à
 * l'écran de l'admin qui permet de relancer la récupération à la main
 * (pour vérifier, après un déploiement, que le service répond bien).
 */
async function rafraichirPrevisions() {
  const { rows: fermes } = await pool.query(
    `SELECT id, nom, latitude, longitude
       FROM fermes
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL`
  );

  const rapport = { fermes: fermes.length, reussies: 0, echouees: [], jours: 0 };

  for (const ferme of fermes) {
    try {
      const previsions = await previsionPour(ferme.latitude, ferme.longitude);
      for (const p of previsions) {
        await pool.query(
          `INSERT INTO previsions_meteo (ferme_id, jour, tmax, tmin, recupere_le)
           VALUES ($1, $2::date, $3, $4, now())
           ON CONFLICT (ferme_id, jour)
           DO UPDATE SET tmax = EXCLUDED.tmax, tmin = EXCLUDED.tmin, recupere_le = now()`,
          [ferme.id, p.jour, p.tmax, p.tmin]
        );
        rapport.jours += 1;
      }
      rapport.reussies += 1;
    } catch (erreur) {
      // Une ferme qui échoue n'empêche pas les autres : une panne réseau
      // passagère ne doit pas priver toute la plateforme d'alertes.
      rapport.echouees.push({ ferme: ferme.nom, raison: erreur.message });
    }
  }

  // Les prévisions d'hier et d'avant ne servent plus à rien.
  await pool.query("DELETE FROM previsions_meteo WHERE jour < current_date");

  return rapport;
}

module.exports = { previsionPour, rafraichirPrevisions };
