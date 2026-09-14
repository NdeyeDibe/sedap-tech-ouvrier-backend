-- Correction : poulaillers.ferme_id était en ON DELETE CASCADE.
-- Un poulailler est un bâtiment physique, avec ses bandes, ses saisies et
-- ses ventes. Supprimer une fiche ferme — une erreur de saisie, un compte
-- de test — aurait effacé toute cette production. Le poulailler doit
-- survivre à sa ferme et se voir simplement détaché.

BEGIN;

ALTER TABLE poulaillers DROP CONSTRAINT IF EXISTS poulaillers_ferme_id_fkey;
ALTER TABLE poulaillers
  ADD CONSTRAINT poulaillers_ferme_id_fkey
  FOREIGN KEY (ferme_id) REFERENCES fermes(id) ON DELETE SET NULL;

COMMIT;
