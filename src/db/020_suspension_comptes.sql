-- Fiche du propriétaire et suspension d'un compte — cahier admin VII,
-- maquettes 12 et 13.
--
-- Deux manques en base :
--
--  1. La dernière connexion. Les admins l'ont déjà (016) ; les
--     propriétaires et les ouvriers non. Sans elle, SEDAP ne peut pas
--     savoir si un client a cessé d'utiliser l'appli — ce qui est
--     précisément le genre de chose qu'on veut voir sur sa fiche.
--
--  2. La suspension. Jusqu'ici un compte ne pouvait être que verrouillé
--     (3 codes PIN faux), ce qui est un accident, pas une décision. La
--     suspension est une décision de SEDAP, avec un motif, et elle se
--     lève. Elle bloque aussi les OUVRIERS de la ferme : suspendre le
--     propriétaire en laissant ses ouvriers saisir donnerait des données
--     que plus personne ne regarde.
--
-- Rien n'est effacé par une suspension : bandes, saisies, ventes et
-- bilans restent consultables par SEDAP (maquette 13).
--
-- Pas de BEGIN/COMMIT : migrate.js joue déjà chaque fichier dans une
-- transaction.

ALTER TABLE proprietaires
  ADD COLUMN IF NOT EXISTS derniere_connexion TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspendu_le TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspendu_motif TEXT,
  -- Qui a suspendu : une décision pareille doit porter un nom.
  ADD COLUMN IF NOT EXISTS suspendu_par INTEGER REFERENCES admins(id);

ALTER TABLE ouvriers
  ADD COLUMN IF NOT EXISTS derniere_connexion TIMESTAMPTZ;

-- Un motif sans suspension, ou l'inverse, n'aurait pas de sens.
ALTER TABLE proprietaires DROP CONSTRAINT IF EXISTS suspension_motivee;
ALTER TABLE proprietaires ADD CONSTRAINT suspension_motivee
  CHECK (suspendu_le IS NULL OR suspendu_motif IS NOT NULL);

-- Les écrans admin listent souvent les comptes suspendus : un index
-- partiel suffit, ils sont rares par construction.
CREATE INDEX IF NOT EXISTS proprietaires_suspendus
  ON proprietaires (suspendu_le) WHERE suspendu_le IS NOT NULL;
