-- Origine du paiement d'une réception de stock (retour Ndeye, sept. 2026) :
-- le propriétaire peut commander et payer lui-même un produit (ex: 100
-- sacs d'aliment) et l'envoyer directement à la ferme. L'ouvrier ne
-- réceptionne alors que la QUANTITÉ reçue — il ne connaît pas le prix
-- payé par le propriétaire, qui devra le renseigner plus tard depuis son
-- interface (pour que le bilan financier reste correct). C'est la même
-- logique que la vente en "ramassage" (003_regles_vente.sql /
-- 002_proprietaire.sql) : prix_unitaire devient NULLABLE, une colonne
-- "source" retient qui a payé.
--
-- Tant que le propriétaire n'a pas encore d'écran pour compléter ces prix
-- manquants, ces réceptions restent à prix NULL — sans effet sur le stock
-- (déjà crédité de la quantité) ni sur le calcul du bilan : la vue
-- depenses_bandes (008_depenses_bande.sql) fait sum(quantite * prix), et
-- SQL ignore déjà les NULL dans un sum(), donc une réception sans prix
-- n'entre simplement pas encore dans le total tant qu'elle n'est pas
-- complétée.

BEGIN;

ALTER TABLE stock_receptions
  ALTER COLUMN prix_unitaire DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'ouvrier'
    CHECK (source IN ('ouvrier', 'proprietaire'));

ALTER TABLE stock_autres_produits
  ALTER COLUMN prix_unitaire DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'ouvrier'
    CHECK (source IN ('ouvrier', 'proprietaire'));

COMMIT;
