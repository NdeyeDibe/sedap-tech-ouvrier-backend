-- Les flacons se suivent par contenance, pas en doses globales.
--
-- POURQUOI (Ndeye, 16 nov. 2026). Un même vaccin arrive en flacons de
-- 500 ou de 1 000 doses, et les deux cohabitent dans le poulailler. Pour
-- 4 092 sujets, le responsable peut ouvrir 4 flacons de 1 000 plus un de
-- 500 — 4 500 doses, 408 perdues — là où cinq flacons de 1 000 en
-- perdraient 908. Il peut aussi n'avoir que des flacons de 500 et en
-- ouvrir 9. L'application doit donc raisonner sur ce qu'il a vraiment
-- sur l'étagère.
--
-- Or le stock est tenu en doses : 4 500 doses, ce peut être 4 flacons de
-- 1 000 et un de 500, ou 9 de 500. L'information était perdue.
--
-- ON NE LA STOCKE PAS, ON LA RECALCULE. Les réceptions enregistrent déjà
-- les flacons ET leur contenance (unites_recues, doses_par_unite). Il
-- manquait seulement la trace de ce qui est SORTI, par contenance :
-- c'est ce que ces deux colonnes ajoutent. Les flacons disponibles par
-- format se déduisent alors des réceptions moins les consommations —
-- même principe que les dépenses, les alertes ou l'état des bandes, qui
-- ne sont stockés nulle part.
--
-- `stock_produits.quantite` reste tenu en doses : c'est lui que lisent
-- les dépenses et l'écran du stock, et le total doit continuer de
-- fonctionner pour les produits qui n'ont pas de contenance.
--
-- Pas de BEGIN/COMMIT : migrate.js enveloppe déjà chaque fichier.

-- À quelle ligne de stock cette vaccination a puisé. Sans ce lien, on ne
-- peut pas savoir quels flacons ont quitté quelle étagère.
ALTER TABLE vaccinations
  ADD COLUMN IF NOT EXISTS stock_produit_id integer REFERENCES stock_produits(id) ON DELETE SET NULL;

-- Le détail de ce qui a été ouvert, par contenance :
--   [{"doses": 1000, "flacons": 4}, {"doses": 500, "flacons": 1}]
--
-- Du JSON et non deux colonnes : le nombre de formats n'est pas figé —
-- aujourd'hui 500 et 1 000, demain autre chose — et une table séparée
-- pour deux lignes par vaccination coûterait plus qu'elle ne rapporte.
ALTER TABLE vaccinations
  ADD COLUMN IF NOT EXISTS flacons_detail jsonb;

-- Reprise des vaccinations déjà enregistrées avec un format unique
-- (colonnes ajoutées le 16 nov. 2026, migration 038) : sans ça, leurs
-- flacons ne seraient jamais décomptés et le stock par format
-- surestimerait ce qui reste sur l'étagère.
UPDATE vaccinations v
   SET flacons_detail = jsonb_build_array(
         jsonb_build_object('doses', v.doses_par_flacon, 'flacons', v.flacons_utilises))
 WHERE v.flacons_detail IS NULL
   AND v.doses_par_flacon IS NOT NULL
   AND v.flacons_utilises IS NOT NULL
   AND v.flacons_utilises > 0;
