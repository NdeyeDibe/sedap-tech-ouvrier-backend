-- Date de prise de vue des photos de saisie.
--
-- Les photos de mortalité sont des preuves. Tant que l'ouvrier pouvait en
-- importer une depuis la galerie de son téléphone, rien n'empêchait
-- d'envoyer la photo d'hier — ou d'une autre ferme — en la donnant pour les
-- morts du jour (retour Mengué, sept. 2026).
--
-- L'application ouvrier ouvre désormais l'appareil photo et refuse une
-- photo qui n'a pas été prise dans les heures qui précèdent. Cette table
-- garde la date lue, pour que SEDAP et le propriétaire la voient sous la
-- photo : « prise à 07:41 » vaut mieux qu'une promesse.
--
-- Pourquoi une table à côté plutôt qu'une colonne : saisies_mortalite.photos
-- et saisies_sante.photos sont des tableaux d'adresses, lus par une dizaine
-- de requêtes. Un second tableau parallèle finirait désynchronisé au premier
-- oubli. Ici l'adresse est la clé, et ce qu'on sait d'une photo vit au même
-- endroit qu'elle soit de mortalité ou de santé.
--
-- Pas de BEGIN/COMMIT : migrate.js joue déjà chaque fichier dans une
-- transaction.

CREATE TABLE IF NOT EXISTS photos_saisies (
  url TEXT PRIMARY KEY,
  bande_id INT REFERENCES bandes(id) ON DELETE CASCADE,
  date_saisie DATE,

  -- D'où vient la date :
  --   exif     — l'appareil photo l'a écrite au déclenchement, c'est la
  --              plus sûre ;
  --   fichier  — date de modification du fichier, prise quand l'EXIF
  --              manque (certains téléphones le retirent) ;
  --   inconnue — rien n'a pu être lu. La photo est acceptée, mais SEDAP
  --              doit savoir qu'elle n'est pas datée.
  origine VARCHAR(10) NOT NULL DEFAULT 'inconnue'
    CHECK (origine IN ('exif', 'fichier', 'inconnue')),
  prise_le TIMESTAMPTZ,

  -- Quand le serveur l'a reçue. Toujours connue, elle : un écart important
  -- entre prise_le et recue_le se voit.
  recue_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS photos_saisies_bande
  ON photos_saisies (bande_id, date_saisie);
