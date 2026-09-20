-- Réceptions de stock côté propriétaire — suite de 014_reception_source.sql.
--
-- Depuis 014, une réception peut avoir été payée par le propriétaire
-- (source = 'proprietaire'), et son prix reste NULL tant qu'il ne l'a pas
-- renseigné. Trois conséquences traitées ici :
--
--  1. Une vue unique sur les deux tables de réception (stock_receptions et
--     stock_autres_produits), avec la bande rattachée. L'écran propriétaire,
--     les alertes et le calcul des dépenses lisent tous cette vue : une seule
--     définition du rattachement, au lieu de trois copies qui dérivent.
--  2. Les dépenses ignoraient silencieusement une réception sans prix —
--     sum(quantite * NULL) vaut NULL. Elles comptent désormais ces lignes à 0
--     et signalent combien de réceptions attendent leur prix.
--  3. Un journal des réceptions déjà notifiées, pour que la surveillance
--     prévienne le propriétaire une seule fois par réception.
--
-- Rattachement à une bande : toujours par plage de dates, comme dans
-- 008_depenses_bande.sql. Une colonne bande_id sur stock_receptions serait
-- plus exacte, mais il faudrait la remplir côté ouvrier, la reprendre sur
-- l'existant, et gérer les réceptions faites entre deux bandes. Tant que le
-- poulailler n'héberge qu'une bande à la fois, la date suffit et reste la
-- seule règle à maintenir.

BEGIN;

-- Filet de sécurité si 014 n'a pas été jouée sur cette base (poste neuf).
ALTER TABLE stock_receptions
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'ouvrier';
ALTER TABLE stock_autres_produits
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'ouvrier';
ALTER TABLE stock_receptions ALTER COLUMN prix_unitaire DROP NOT NULL;
ALTER TABLE stock_autres_produits ALTER COLUMN prix_unitaire DROP NOT NULL;

ALTER TABLE stock_receptions DROP CONSTRAINT IF EXISTS stock_receptions_source_check;
ALTER TABLE stock_receptions ADD CONSTRAINT stock_receptions_source_check
  CHECK (source IN ('ouvrier', 'proprietaire'));
ALTER TABLE stock_autres_produits DROP CONSTRAINT IF EXISTS stock_autres_produits_source_check;
ALTER TABLE stock_autres_produits ADD CONSTRAINT stock_autres_produits_source_check
  CHECK (source IN ('ouvrier', 'proprietaire'));

-- Une réception payée par l'ouvrier porte forcément son prix : c'est lui qui
-- l'a déboursé. L'absence de prix n'est tolérée que pour un achat du
-- propriétaire, en attendant qu'il le renseigne.
ALTER TABLE stock_receptions DROP CONSTRAINT IF EXISTS reception_prix_si_ouvrier;
ALTER TABLE stock_receptions ADD CONSTRAINT reception_prix_si_ouvrier
  CHECK (source = 'proprietaire' OR prix_unitaire IS NOT NULL);
ALTER TABLE stock_autres_produits DROP CONSTRAINT IF EXISTS autre_prix_si_ouvrier;
ALTER TABLE stock_autres_produits ADD CONSTRAINT autre_prix_si_ouvrier
  CHECK (source = 'proprietaire' OR prix_unitaire IS NOT NULL);

-- ------------------------------------------------ la vue des réceptions

-- « origine » distingue les deux tables : leurs identifiants se chevauchent,
-- la paire (origine, id) est la seule clé utilisable côté API.
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
FROM stock_autres_produits sap;

-- ------------------------------------------------ dépenses par bande

-- Même contenu qu'en 008, calculé depuis la vue ci-dessus, plus deux
-- colonnes : la quantité et le nombre de réceptions encore sans prix.
CREATE OR REPLACE VIEW depenses_bandes AS
SELECT
  r.bande_id,
  r.poste,
  sum(r.quantite)                                  AS quantite,
  sum(r.quantite * coalesce(r.prix_unitaire, 0))   AS cout,
  count(*) FILTER (WHERE r.prix_unitaire IS NULL)  AS receptions_sans_prix,
  coalesce(sum(r.quantite) FILTER (WHERE r.prix_unitaire IS NULL), 0) AS quantite_sans_prix
FROM receptions_ferme r
WHERE r.bande_id IS NOT NULL
GROUP BY r.bande_id, r.poste;

-- Le bilan reprend ces dépenses et signale, comme pour les sujets ramassés
-- sans prix, ce qui manque encore pour qu'il soit complet.
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
  -- Ajoutée en fin de liste : CREATE OR REPLACE VIEW ne sait qu'ajouter des
  -- colonnes à la suite, jamais en insérer au milieu.
  coalesce((SELECT sum(d.receptions_sans_prix) FROM depenses_bandes d WHERE d.bande_id = b.id), 0)
    AS receptions_sans_prix
FROM bandes b
LEFT JOIN etat_bandes e ON e.bande_id = b.id
LEFT JOIN recettes_bandes r ON r.bande_id = b.id;

-- ------------------------------------------- journal des notifications

-- Les alertes se déduisent de l'état courant ; une réception, elle, est un
-- événement : une fois annoncée, rien dans la base ne dit qu'elle l'a été.
-- D'où ce journal, sur le modèle d'alertes_notifiees.
CREATE TABLE IF NOT EXISTS receptions_notifiees (
  origine TEXT NOT NULL,
  reception_id INT NOT NULL,
  proprietaire_id INT NOT NULL REFERENCES proprietaires(id) ON DELETE CASCADE,
  envoye_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (origine, reception_id, proprietaire_id)
);

COMMIT;
