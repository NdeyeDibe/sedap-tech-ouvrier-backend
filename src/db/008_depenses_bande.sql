-- Dépenses d'une bande, pour le bilan financier (CDC IX.3).
--
-- Les réceptions de stock portent déjà les prix payés, mais elles sont
-- rattachées au poulailler, pas à la bande : impossible de dire ce qu'une
-- bande précise a coûté. On ventile donc par date, en rattachant chaque
-- réception à la bande active au moment où elle a eu lieu.
--
-- Approximation assumée : une réception faite entre deux bandes n'est
-- imputée à aucune. Mieux vaudrait une colonne bande_id sur
-- stock_receptions, à ajouter côté ouvrier quand l'occasion se présentera.

BEGIN;

CREATE OR REPLACE VIEW depenses_bandes AS
WITH receptions AS (
  SELECT
    b.id AS bande_id,
    sp.produit_id,
    sum(sr.quantite_recue)                     AS quantite,
    sum(sr.quantite_recue * sr.prix_unitaire)  AS cout
  FROM bandes b
  JOIN poulaillers pl ON pl.id = b.poulailler_id
  JOIN stock_produits sp ON sp.poulailler_id = pl.id
  JOIN stock_receptions sr ON sr.stock_produit_id = sp.id
  WHERE sr.date_reception >= b.date_debut
    AND (b.date_fin IS NULL OR sr.date_reception <= b.date_fin)
  GROUP BY b.id, sp.produit_id
),
autres AS (
  SELECT
    b.id AS bande_id,
    sum(sap.quantite)                      AS quantite,
    sum(sap.quantite * sap.prix_unitaire)  AS cout
  FROM bandes b
  JOIN poulaillers pl ON pl.id = b.poulailler_id
  JOIN stock_autres_produits sap ON sap.poulailler_id = pl.id
  WHERE sap.date_reception >= b.date_debut
    AND (b.date_fin IS NULL OR sap.date_reception <= b.date_fin)
  GROUP BY b.id
)
SELECT bande_id, produit_id AS poste, quantite, cout FROM receptions
UNION ALL
SELECT bande_id, 'autres' AS poste, quantite, cout FROM autres;

-- Bilan complet d'une bande : dépenses, recettes connues, bénéfice net.
CREATE OR REPLACE VIEW bilans_bandes AS
SELECT
  b.id AS bande_id,
  b.poulailler_id,
  b.numero,
  b.statut,
  b.date_debut,
  b.date_fin,
  (coalesce(b.date_fin, now())::date - b.date_debut::date) AS duree_jours,
  e.morts,
  e.vendus,
  e.taux_mortalite,
  coalesce((SELECT sum(d.cout) FROM depenses_bandes d WHERE d.bande_id = b.id), 0)
    AS total_depenses,
  r.recettes AS total_recettes,
  r.sujets_sans_prix,
  r.recettes
    - coalesce((SELECT sum(d.cout) FROM depenses_bandes d WHERE d.bande_id = b.id), 0)
    AS benefice_net
FROM bandes b
LEFT JOIN etat_bandes e ON e.bande_id = b.id
LEFT JOIN recettes_bandes r ON r.bande_id = b.id;

COMMIT;
