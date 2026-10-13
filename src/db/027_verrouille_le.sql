-- Date de verrouillage d'un compte responsable.
--
-- Le drapeau compte_verrouille disait QUE le compte était bloqué, jamais
-- DEPUIS QUAND. L'alerte envoyée au propriétaire et à SEDAP affichait
-- donc toujours « aujourd'hui », même sur un compte bloqué depuis une
-- semaine — c'est précisément la question qu'on se pose en la lisant.
--
-- Pas de BEGIN/COMMIT ici : migrate.js enveloppe déjà chaque fichier.

-- Les deux tables, et pas seulement les responsables : le déverrouillage
-- de l'admin est une seule requête écrite pour les deux (adminComptes
-- Controller), elle doit trouver la colonne des deux côtés.
ALTER TABLE ouvriers
  ADD COLUMN IF NOT EXISTS verrouille_le timestamptz;

ALTER TABLE proprietaires
  ADD COLUMN IF NOT EXISTS verrouille_le timestamptz;

-- Les comptes déjà verrouillés avant cette migration n'ont pas de date
-- connue. On ne l'invente pas : la colonne reste vide, et l'alerte dira
-- simplement « verrouillé » sans ancienneté.
