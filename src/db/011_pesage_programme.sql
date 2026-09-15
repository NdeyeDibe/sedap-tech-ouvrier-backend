-- Le pesage entre dans le programme sanitaire.
--
-- Il vivait en dur dans le front ouvrier (JOURS_PESAGE_CLES = [7,14,21,28,35])
-- et n'existait nulle part en base : un pesage oublié ne laissait aucune
-- trace, donc rien à signaler au propriétaire. Même angle mort que pour les
-- vaccins avant le programme.
--
-- Trois natures cohabitent désormais. Comme pour les traitements, un pesage
-- manqué se voit sans déclencher l'alerte du CDC, réservée aux vaccins.

BEGIN;

ALTER TABLE programme_sanitaire DROP CONSTRAINT IF EXISTS programme_sanitaire_type_check;
ALTER TABLE programme_sanitaire ADD CONSTRAINT programme_sanitaire_type_check
  CHECK (type IN ('vaccin', 'traitement', 'pesage'));

INSERT INTO programme_sanitaire (nom, type, jour_debut, jour_fin, ordre) VALUES
  ('Pesage', 'pesage',  7, NULL, 101),
  ('Pesage', 'pesage', 14, NULL, 102),
  ('Pesage', 'pesage', 21, NULL, 103),
  ('Pesage', 'pesage', 28, NULL, 104),
  ('Pesage', 'pesage', 35, NULL, 105)
ON CONFLICT (ordre) DO NOTHING;

-- La vue rapprochait les actes de la table vaccinations. Les pesages, eux,
-- sont enregistrés dans pesages : il faut regarder les deux, selon le type.
CREATE OR REPLACE VIEW programme_bandes AS
SELECT
  b.id AS bande_id,
  ps.ordre,
  ps.nom,
  ps.type,
  ps.jour_debut,
  ps.jour_fin,
  (b.date_debut::date + ps.jour_debut - 1)                        AS date_prevue,
  (b.date_debut::date + coalesce(ps.jour_fin, ps.jour_debut) - 1) AS date_limite,
  CASE
    WHEN ps.type = 'pesage' THEN pe.id IS NOT NULL
    ELSE v.id IS NOT NULL
  END AS confirme,
  CASE
    WHEN ps.type = 'pesage' THEN pe.date_saisie
    ELSE v.date_saisie
  END AS date_faite,
  (
    CASE WHEN ps.type = 'pesage' THEN pe.id IS NULL ELSE v.id IS NULL END
    AND (b.date_debut::date + coalesce(ps.jour_fin, ps.jour_debut) - 1) < current_date
  ) AS en_retard
FROM bandes b
CROSS JOIN programme_sanitaire ps
LEFT JOIN vaccinations v
  ON ps.type <> 'pesage'
 AND v.bande_id = b.id
 AND lower(v.vaccin_nom) = lower(ps.nom)
 AND v.jour_bande BETWEEN ps.jour_debut AND coalesce(ps.jour_fin, ps.jour_debut)
LEFT JOIN pesages pe
  ON ps.type = 'pesage'
 AND pe.bande_id = b.id
 AND pe.jour_bande = ps.jour_debut;

COMMIT;
