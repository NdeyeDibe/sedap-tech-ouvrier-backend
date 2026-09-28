-- Programme sanitaire et listes de référence — cahier admin, maquettes 21
-- et 22.
--
-- Trois manques, dont un grave.
--
-- 1. LE PROGRAMME ÉTAIT PARTAGÉ PAR TOUTES LES BANDES.
--
--    `programme_bandes` fait un CROSS JOIN sur `programme_sanitaire` :
--    déplacer un vaccin de J9 à J10 déplaçait le vaccin de TOUTES les
--    bandes en cours, y compris celles de J20 — et pouvait mettre en
--    retard, rétroactivement, des actes déjà faits. La maquette 21 promet
--    l'inverse : « les bandes actives gardent leur programme ».
--
--    Correction : chaque bande reçoit sa COPIE du programme à son
--    démarrage. Modifier le programme n'a plus d'effet sur ce qui tourne,
--    et renommer un acte ne peut plus mettre une bande en retard, puisque
--    la bande garde le nom qu'elle avait.
--
-- 2. Le programme ne portait que nom, type et jours. La maquette y ajoute
--    les produits, le mode d'administration et le poids attendu pour les
--    pesages.
--
-- 3. Les listes de couvoirs, souches et fournisseurs vivaient en dur dans
--    le front de l'ouvrier. Un nouveau couvoir demandait un déploiement.
--
-- Pas de BEGIN/COMMIT : migrate.js joue déjà chaque fichier dans une
-- transaction.

-- ------------------------------------------------ le programme de référence

ALTER TABLE programme_sanitaire
  -- Les produits sont une liste : « Covit, Aliseryl » n'est pas un nom de
  -- produit, c'est deux.
  ADD COLUMN IF NOT EXISTS produits TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS administration TEXT,
  -- Fourchette attendue pour un pesage, en grammes. Deux colonnes plutôt
  -- qu'un texte « 160-220 g » : l'appli doit pouvoir comparer.
  ADD COLUMN IF NOT EXISTS poids_min_g INTEGER,
  ADD COLUMN IF NOT EXISTS poids_max_g INTEGER;

ALTER TABLE programme_sanitaire DROP CONSTRAINT IF EXISTS poids_coherent;
ALTER TABLE programme_sanitaire ADD CONSTRAINT poids_coherent
  CHECK (poids_min_g IS NULL OR poids_max_g IS NULL OR poids_min_g <= poids_max_g);

-- ------------------------------------------------- le programme d'une bande

CREATE TABLE IF NOT EXISTS programme_actes_bande (
  bande_id INTEGER NOT NULL REFERENCES bandes(id) ON DELETE CASCADE,
  ordre INTEGER NOT NULL,
  nom VARCHAR(100) NOT NULL,
  type VARCHAR(20) NOT NULL,
  jour_debut INTEGER NOT NULL,
  jour_fin INTEGER,
  produits TEXT[] NOT NULL DEFAULT '{}',
  administration TEXT,
  poids_min_g INTEGER,
  poids_max_g INTEGER,
  PRIMARY KEY (bande_id, ordre)
);

-- Les bandes existantes reçoivent la copie du programme actuel : sans ça,
-- elles perdraient leur programme au changement de vue ci-dessous.
--
-- Le NOT EXISTS porte sur la bande entière, pas sur la ligne : une bande
-- qui a déjà sa copie est laissée telle quelle. Écarter ligne à ligne
-- (ON CONFLICT sur bande_id + ordre) ne protégerait de rien, puisque les
-- numéros d'ordre de la référence changent quand on y ajoute un acte — une
-- seconde exécution ajouterait alors les nouveaux numéros à côté des
-- anciens, et la bande se retrouverait avec un programme en double.
INSERT INTO programme_actes_bande
  (bande_id, ordre, nom, type, jour_debut, jour_fin, produits, administration, poids_min_g, poids_max_g)
SELECT b.id, ps.ordre, ps.nom, ps.type, ps.jour_debut, ps.jour_fin,
       ps.produits, ps.administration, ps.poids_min_g, ps.poids_max_g
  FROM bandes b CROSS JOIN programme_sanitaire ps
 WHERE NOT EXISTS (
   SELECT 1 FROM programme_actes_bande pa WHERE pa.bande_id = b.id
 );

-- La vue lit désormais le programme DE LA BANDE. Le reste est inchangé :
-- un vaccin se confirme par son nom, un pesage par son jour.
DROP VIEW IF EXISTS programme_bandes;
CREATE VIEW programme_bandes AS
SELECT b.id AS bande_id,
       pa.ordre,
       pa.nom,
       pa.type,
       pa.jour_debut,
       pa.jour_fin,
       pa.produits,
       pa.administration,
       pa.poids_min_g,
       pa.poids_max_g,
       b.date_debut::date + pa.jour_debut - 1 AS date_prevue,
       b.date_debut::date + COALESCE(pa.jour_fin, pa.jour_debut) - 1 AS date_limite,
       CASE WHEN pa.type = 'pesage' THEN pe.id IS NOT NULL ELSE v.id IS NOT NULL END AS confirme,
       CASE WHEN pa.type = 'pesage' THEN pe.date_saisie ELSE v.date_saisie END AS date_faite,
       (CASE WHEN pa.type = 'pesage' THEN pe.id IS NULL ELSE v.id IS NULL END
        AND (b.date_debut::date + COALESCE(pa.jour_fin, pa.jour_debut) - 1) < CURRENT_DATE) AS en_retard
  FROM bandes b
  JOIN programme_actes_bande pa ON pa.bande_id = b.id
  LEFT JOIN vaccinations v
    ON pa.type <> 'pesage' AND v.bande_id = b.id
   AND lower(v.vaccin_nom) = lower(pa.nom)
   AND v.jour_bande >= pa.jour_debut
   AND v.jour_bande <= COALESCE(pa.jour_fin, pa.jour_debut)
  LEFT JOIN pesages pe
    ON pa.type = 'pesage' AND pe.bande_id = b.id AND pe.jour_bande = pa.jour_debut;

-- Une bande nouvelle reçoit sa copie automatiquement : la logique est en
-- base plutôt que dans le contrôleur, parce qu'une bande peut naître de
-- plusieurs endroits et qu'un oubli ici la laisserait sans programme.
CREATE OR REPLACE FUNCTION copier_programme_sur_bande() RETURNS trigger AS $$
BEGIN
  INSERT INTO programme_actes_bande
    (bande_id, ordre, nom, type, jour_debut, jour_fin, produits, administration, poids_min_g, poids_max_g)
  SELECT NEW.id, ps.ordre, ps.nom, ps.type, ps.jour_debut, ps.jour_fin,
         ps.produits, ps.administration, ps.poids_min_g, ps.poids_max_g
    FROM programme_sanitaire ps;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bande_recoit_son_programme ON bandes;
CREATE TRIGGER bande_recoit_son_programme
  AFTER INSERT ON bandes
  FOR EACH ROW EXECUTE FUNCTION copier_programme_sur_bande();

-- ------------------------------------------------- listes de référence

CREATE TABLE IF NOT EXISTS listes_reference (
  id SERIAL PRIMARY KEY,
  liste TEXT NOT NULL CHECK (liste IN ('couvoir', 'souche', 'fournisseur_aliment')),
  valeur TEXT NOT NULL,
  -- Une valeur déjà utilisée ne se supprime pas : la masquer la retire des
  -- listes de l'ouvrier sans effacer l'historique des bandes qui la
  -- portent (maquette 22).
  masque BOOLEAN NOT NULL DEFAULT false,
  ordre INTEGER NOT NULL DEFAULT 0,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT valeur_unique_par_liste UNIQUE (liste, valeur)
);

-- Les valeurs qui vivaient en dur dans le front de l'ouvrier.
INSERT INTO listes_reference (liste, valeur, ordre) VALUES
  ('couvoir', 'Zalar', 1), ('couvoir', 'Sedima', 2), ('couvoir', 'Aviboy', 3),
  ('couvoir', 'Avifrique', 4), ('couvoir', 'APRAN', 5), ('couvoir', 'Couvoir AMAR', 6),
  ('couvoir', 'JAI LAXMI', 7), ('couvoir', 'AVIA', 8), ('couvoir', 'PRODAS', 9),
  ('couvoir', 'AVITECH', 10), ('couvoir', 'Autre', 99),
  ('souche', 'Cobb 500', 1), ('souche', 'Ross', 2), ('souche', 'Hubbard', 3),
  ('souche', 'Autre', 99),
  ('fournisseur_aliment', 'Avisen', 1), ('fournisseur_aliment', 'GMD', 2),
  ('fournisseur_aliment', 'NMA', 3), ('fournisseur_aliment', 'Sedima', 4),
  ('fournisseur_aliment', 'Aviboy', 5), ('fournisseur_aliment', 'Autre', 99)
ON CONFLICT ON CONSTRAINT valeur_unique_par_liste DO NOTHING;

-- ------------------------- le programme de SEDAP, tel qu'il est pratiqué

-- Les 14 actes existaient déjà, mais sans leurs produits ni leurs poids
-- attendus : ils vivaient sur une feuille à part. Les voici, repris de la
-- maquette 21. Sans cette reprise, SEDAP devrait retaper quatorze lignes
-- avant que l'écran serve à quelque chose.
UPDATE programme_sanitaire SET produits = v.produits,
       administration = v.administration,
       poids_min_g = v.poids_min, poids_max_g = v.poids_max
  FROM (VALUES
    ('Vitamine / Antistress', 1, ARRAY['Amintotal','Covit','Aliseryl'], 'Eau de boisson', NULL::int, NULL::int),
    ('Pesage',                7, ARRAY[]::text[], NULL,                      160,  220),
    ('Gumboro L',             9, ARRAY[]::text[], 'Eau minérale ou de puits', NULL, NULL),
    ('Antistress',            9, ARRAY['Covit','Aliseryl'], 'Eau de boisson', NULL, NULL),
    ('Gumboro IBDL',         14, ARRAY[]::text[], 'Eau minérale ou de puits', NULL, NULL),
    ('Pesage',               14, ARRAY[]::text[], NULL,                      450,  600),
    ('Antistress',           14, ARRAY['Covit','Aliseryl'], 'Eau de boisson', NULL, NULL),
    ('Anticoccidien',        18, ARRAY['Anticox'], 'Eau de boisson',          NULL, NULL),
    ('Lasota',               21, ARRAY[]::text[], 'Eau minérale ou de puits', NULL, NULL),
    ('Pesage',               21, ARRAY[]::text[], NULL,                      800, 1000),
    ('Antistress',           21, ARRAY['Covit','Aliseryl'], 'Eau de boisson', NULL, NULL),
    ('Vitamine',             23, ARRAY['Amintotal'], 'Eau de boisson',        NULL, NULL),
    ('Pesage',               28, ARRAY[]::text[], NULL,                     1250, 1550),
    ('Pesage',               35, ARRAY[]::text[], NULL,                     1700, 2200)
  ) AS v(nom, jour, produits, administration, poids_min, poids_max)
 WHERE programme_sanitaire.nom = v.nom
   AND programme_sanitaire.jour_debut = v.jour
   AND programme_sanitaire.produits = '{}'
   AND programme_sanitaire.administration IS NULL;

-- Les bandes déjà copiées plus haut reçoivent la même précision : elles
-- ont été créées avant que ces colonnes soient remplies.
UPDATE programme_actes_bande pa
   SET produits = ps.produits, administration = ps.administration,
       poids_min_g = ps.poids_min_g, poids_max_g = ps.poids_max_g
  FROM programme_sanitaire ps
 WHERE pa.nom = ps.nom AND pa.jour_debut = ps.jour_debut
   AND pa.produits = '{}' AND pa.administration IS NULL;
