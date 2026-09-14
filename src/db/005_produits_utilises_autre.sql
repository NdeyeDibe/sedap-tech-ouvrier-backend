-- La colonne "Autre produit" a été ajoutée à schema.sql après coup. Sur une
-- base créée avant, CREATE TABLE IF NOT EXISTS n'a pas touché la table :
-- elle manque encore, et getSaisieDuJour échoue en la lisant.

BEGIN;

ALTER TABLE produits_utilises
  ADD COLUMN IF NOT EXISTS stock_autre_produit_id INT REFERENCES stock_autres_produits(id);

ALTER TABLE produits_utilises DROP CONSTRAINT IF EXISTS un_seul_type_de_produit;
ALTER TABLE produits_utilises ADD CONSTRAINT un_seul_type_de_produit CHECK (
  (stock_produit_id IS NOT NULL AND stock_autre_produit_id IS NULL) OR
  (stock_produit_id IS NULL AND stock_autre_produit_id IS NOT NULL)
) NOT VALID;

COMMIT;
