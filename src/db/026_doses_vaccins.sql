-- Un vaccin s'achète en flacons, il se consomme en doses.
--
-- Le stock des vaccins est compté en doses depuis le début : c'est la
-- bonne unité, celle qui permet de dire « il faut 2 000 doses pour 1 997
-- sujets ». Mais la réception, elle, comptait des flacons et ajoutait ce
-- nombre tel quel au stock. Quatre flacons de 1 000 doses et un de 500
-- donnaient donc « 5 doses » en stock, et toute vaccination devenait
-- impossible (retour Ndeye, sept. 2026).
--
-- L'écran Vaccin de l'application ouvrier avait bien un sélecteur
-- 500 / 1 000 doses, mais sa valeur n'était jamais envoyée au serveur.
--
-- Deux colonnes pour réparer, et garder la trace de ce qui a été acheté :
-- une réception de vaccin enregistre désormais le nombre de flacons ET
-- leur contenance, tandis que quantite_recue reste dans l'unité du stock
-- (les doses), pour que la vue des dépenses et les contrôles de stock
-- négatif continuent de dire vrai.
--
-- Pas de BEGIN/COMMIT : migrate.js joue déjà chaque fichier dans une
-- transaction.

ALTER TABLE stock_receptions
  ADD COLUMN IF NOT EXISTS unites_recues NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS doses_par_unite INT;

COMMENT ON COLUMN stock_receptions.unites_recues IS
  'Ce que la personne a compté : 4 flacons, 3 sacs, 2 bouteilles.';
COMMENT ON COLUMN stock_receptions.doses_par_unite IS
  'Contenance d''une unité, pour les produits dosés (vaccins). NULL ailleurs.';

-- Le prix enregistré est celui d'UNE unité de stock. Pour un vaccin,
-- c'est donc le prix d'une dose : un flacon de 1 000 doses à 12 000 F
-- donne 12 F la dose, et la vue des dépenses retrouve bien 12 000 F.
--
-- La colonne garde ses deux décimales. Passer à quatre aurait demandé de
-- supprimer et recréer trois vues qui en dépendent (receptions_ferme,
-- depenses_bandes, bilans_bandes) — beaucoup de risque pour un arrondi
-- qui, au pire, décale le coût d'un flacon de 5 francs.

-- Les réceptions déjà enregistrées gardent leurs chiffres : personne ne
-- peut deviner aujourd'hui si un « 5 » voulait dire 5 flacons ou 5 doses.
-- Celles qui sont fausses se corrigent depuis l'interface admin, écran de
-- la bande, section « Réceptions de stock » — la correction ajuste le
-- stock du même écart.
