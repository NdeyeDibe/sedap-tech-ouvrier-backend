-- Prix des poussins (retour Ndeye, sept. 2026).
--
-- Le bilan comptait les poussins à 0 : leur prix n'était saisi nulle part.
-- À la création de la bande, l'ouvrier indique désormais qui les a payés,
-- comme pour une réception de stock :
--  - lui-même : il saisit le prix d'un poussin et la provenance ;
--  - le propriétaire : ni prix ni provenance ; c'est le propriétaire qui les
--    renseigne depuis son écran « Réceptions de stock ».
--
-- Les poussins deviennent ainsi une réception comme une autre (vue
-- receptions_ferme, origine 'poussins') : notification au propriétaire,
-- alerte « à chiffrer », dépenses et bilan en profitent sans code de plus.
--
-- Coût = poussins COMMANDÉS × prix : c'est ce que le couvoir facture (les
-- quelques poussins offerts en plus ne se paient pas). Reçus à défaut.
--
-- Bandes existantes : marquées « payées par le propriétaire », sans prix.
-- Elles apparaissent donc à chiffrer chez lui ; leur provenance est gardée.
--
-- Pas de BEGIN/COMMIT : migrate.js joue déjà chaque fichier dans une
-- transaction.

ALTER TABLE bandes
  ADD COLUMN IF NOT EXISTS poussins_paye_par VARCHAR(20) NOT NULL DEFAULT 'proprietaire'
    CHECK (poussins_paye_par IN ('ouvrier', 'proprietaire')),
  ADD COLUMN IF NOT EXISTS prix_unitaire_poussin NUMERIC(10,2)
    CHECK (prix_unitaire_poussin > 0);

-- Même règle que les réceptions (015) : un achat de l'ouvrier porte son prix.
ALTER TABLE bandes DROP CONSTRAINT IF EXISTS poussins_prix_si_ouvrier;
ALTER TABLE bandes ADD CONSTRAINT poussins_prix_si_ouvrier
  CHECK (poussins_paye_par = 'proprietaire' OR prix_unitaire_poussin IS NOT NULL);

-- Plus de valeur par défaut : l'API dit toujours qui a payé.
ALTER TABLE bandes ALTER COLUMN poussins_paye_par DROP DEFAULT;

-- ------------------------------------------------ la vue des réceptions

-- Reprise de 015, plus une troisième origine : les poussins de chaque bande.
-- Leur identifiant est celui de la bande ; la paire (origine, id) reste unique.
CREATE OR REPLACE VIEW receptions_ferme AS
SELECT
  'produit'::text        AS origine,
  sr.id,
  sp.poulailler_id,
  sp.produit_id          AS poste,
  sp.nom,
  sp.unite,
  sr.quantite_recue      AS quantite,
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
SELECT
  'autre'::text,
  sap.id,
  sap.poulailler_id,
  'autres',
  sap.nom,
  'unités',
  sap.quantite,
  sap.prix_unitaire,
  NULL,
  sap.date_reception,
  sap.source,
  (SELECT b.id FROM bandes b
    WHERE b.poulailler_id = sap.poulailler_id
      AND sap.date_reception >= b.date_debut
      AND (b.date_fin IS NULL OR sap.date_reception <= b.date_fin)
    ORDER BY b.date_debut DESC LIMIT 1)
FROM stock_autres_produits sap
UNION ALL
SELECT
  'poussins'::text,
  b.id,
  b.poulailler_id,
  'poussins',
  'Poussins',
  'sujets',
  coalesce(b.poussins_commandes, b.poussins_recus)::numeric(10,2),
  b.prix_unitaire_poussin,
  b.provenance,
  b.date_debut,
  b.poussins_paye_par,
  b.id
FROM bandes b;

-- ------------------------------------------------ bilans

-- depenses_bandes (015) lit la vue ci-dessus : les poussins y entrent seuls,
-- en poste 'poussins'. Le bilan les sépare des réceptions de stock pour
-- dire précisément ce qui manque.
CREATE OR REPLACE VIEW bilans_bandes AS
SELECT
  b.id AS bande_id,
  b.poulailler_id,
  b.numero,
  b.statut,
  b.date_debut,
  b.date_fin,
  (coalesce(b.date_fin, now())::date - b.date_debut::date + 1) AS duree_jours,
  e.morts,
  e.vendus,
  e.taux_mortalite,
  coalesce((SELECT sum(d.cout) FROM depenses_bandes d WHERE d.bande_id = b.id), 0)
    AS total_depenses,
  r.recettes AS total_recettes,
  r.sujets_sans_prix,
  r.recettes
    - coalesce((SELECT sum(d.cout) FROM depenses_bandes d WHERE d.bande_id = b.id), 0)
    AS benefice_net,
  -- Réceptions de stock seulement : les poussins ont leur propre colonne.
  coalesce((SELECT sum(d.receptions_sans_prix) FROM depenses_bandes d
             WHERE d.bande_id = b.id AND d.poste <> 'poussins'), 0)
    AS receptions_sans_prix,
  -- Ajoutée en fin de liste (CREATE OR REPLACE VIEW n'ajoute qu'à la suite).
  (b.prix_unitaire_poussin IS NULL) AS poussins_sans_prix
FROM bandes b
LEFT JOIN etat_bandes e ON e.bande_id = b.id
LEFT JOIN recettes_bandes r ON r.bande_id = b.id;
