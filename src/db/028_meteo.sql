-- Alerte chaleur : coordonnées des fermes et prévisions de température.
--
-- Le barème de température de l'application (31-34 °C à J1, 20-25 °C
-- après J35) décrit ce qu'il faut DANS le poulailler. Personne ne le
-- mesure : il n'y a ni sonde ni saisie. L'alerte s'appuie donc sur la
-- prévision météo de la commune, qui donne l'extérieur — ce n'est pas la
-- même chose, et les messages le disent clairement.
--
-- Pas de BEGIN/COMMIT : migrate.js enveloppe déjà chaque fichier.

-- Coordonnées de la ferme. Renseignées en choisissant une commune dans
-- l'admin ; `localite` reste le texte libre de l'adresse.
ALTER TABLE fermes
  ADD COLUMN IF NOT EXISTS commune text,
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision;

-- Une ligne par ferme et par jour prévu. On garde la prévision plutôt que
-- d'appeler le service météo à chaque affichage : trois interfaces lisent
-- les alertes, parfois plusieurs fois par minute, et le service est
-- gratuit mais pas illimité.
CREATE TABLE IF NOT EXISTS previsions_meteo (
  ferme_id    integer NOT NULL REFERENCES fermes(id) ON DELETE CASCADE,
  jour        date    NOT NULL,
  tmax        double precision,
  tmin        double precision,
  recupere_le timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ferme_id, jour)
);

-- Les prévisions passées ne servent à rien : l'alerte ne parle que
-- d'aujourd'hui et de demain.
CREATE INDEX IF NOT EXISTS previsions_meteo_jour ON previsions_meteo (jour);
