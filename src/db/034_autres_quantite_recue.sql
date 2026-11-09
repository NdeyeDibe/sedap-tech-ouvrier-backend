-- Séparer « quantité reçue » et « quantité restante » pour les autres produits.
--
-- LE DÉFAUT (signalé par Ndeye, 9 nov. 2026).
-- `stock_autres_produits.quantite` faisait deux métiers à la fois : la
-- quantité RÉCEPTIONNÉE, et le stock RESTANT. Chaque usage déclaré dans
-- « Produits utilisés » la décrémentait (suiviController) — et comme la
-- vue des réceptions lisait la même colonne, la réception rétrécissait à
-- mesure que le produit était consommé. Un produit entièrement utilisé
-- s'affichait « 0 unités », et le propriétaire qui saisissait son prix
-- obtenait 0 × prix = 0.
--
-- CE N'ÉTAIT PAS QU'UN AFFICHAGE. depenses_bandes est bâtie sur
-- receptions_ferme : la dépense de ce produit disparaissait aussi du
-- bilan financier de la bande, celui que JARIN facture.
--
-- Les produits du catalogue n'avaient pas ce problème : leurs réceptions
-- vivent dans `stock_receptions` (jamais modifiée) et leur stock dans
-- `stock_produits.quantite`. Deux colonnes, deux métiers. On aligne les
-- « autres produits » sur ce modèle.
--
-- LA REPRISE EST EXACTE, PAS ESTIMÉE : chaque usage est enregistré dans
-- `produits_utilises`. La quantité reçue se reconstitue donc comme
-- « ce qui reste » + « tout ce qui a été utilisé ».
--
-- Pas de BEGIN/COMMIT : migrate.js enveloppe déjà chaque fichier.

ALTER TABLE stock_autres_produits
  ADD COLUMN IF NOT EXISTS quantite_recue numeric(10, 2);

UPDATE stock_autres_produits sap
   SET quantite_recue = sap.quantite + COALESCE((
         SELECT sum(pu.quantite)
           FROM produits_utilises pu
          WHERE pu.stock_autre_produit_id = sap.id
       ), 0)
 WHERE sap.quantite_recue IS NULL;

-- Plus aucune ligne ne doit naître sans : une réception sans quantité
-- reçue serait de nouveau invisible dans les dépenses.
ALTER TABLE stock_autres_produits
  ALTER COLUMN quantite_recue SET NOT NULL;

-- La vue des réceptions lit désormais la quantité reçue. Seule la
-- branche « autre » change ; les deux autres sont réécrites à
-- l'identique parce que CREATE OR REPLACE exige la définition entière.
CREATE OR REPLACE VIEW receptions_ferme AS
  SELECT 'produit'::text AS origine,
         sr.id,
         sp.poulailler_id,
         sp.produit_id AS poste,
         sp.nom,
         sp.unite,
         sr.quantite_recue AS quantite,
         sr.prix_unitaire,
         sr.provenance,
         sr.date_reception,
         sr.source,
         (SELECT b.id FROM bandes b
           WHERE b.poulailler_id = sp.poulailler_id
             AND sr.date_reception >= b.date_debut
             AND (b.date_fin IS NULL OR sr.date_reception <= b.date_fin)
           ORDER BY b.date_debut DESC LIMIT 1) AS bande_id
    FROM stock_receptions sr
    JOIN stock_produits sp ON sp.id = sr.stock_produit_id
  UNION ALL
  SELECT 'autre'::text AS origine,
         sap.id,
         sap.poulailler_id,
         'autres'::character varying AS poste,
         sap.nom,
         'unités'::character varying AS unite,
         -- ICI le correctif : la quantité reçue, pas le stock restant.
         sap.quantite_recue AS quantite,
         sap.prix_unitaire,
         NULL::character varying AS provenance,
         sap.date_reception,
         sap.source,
         (SELECT b.id FROM bandes b
           WHERE b.poulailler_id = sap.poulailler_id
             AND sap.date_reception >= b.date_debut
             AND (b.date_fin IS NULL OR sap.date_reception <= b.date_fin)
           ORDER BY b.date_debut DESC LIMIT 1) AS bande_id
    FROM stock_autres_produits sap
  UNION ALL
  SELECT 'poussins'::text AS origine,
         b.id,
         b.poulailler_id,
         'poussins'::character varying AS poste,
         'Poussins'::character varying AS nom,
         'sujets'::character varying AS unite,
         COALESCE(b.poussins_commandes, b.poussins_recus)::numeric(10, 2) AS quantite,
         b.prix_unitaire_poussin AS prix_unitaire,
         b.provenance,
         b.date_debut AS date_reception,
         b.poussins_paye_par AS source,
         b.id AS bande_id
    FROM bandes b;
