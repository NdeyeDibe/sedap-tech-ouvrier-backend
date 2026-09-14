-- Recalage du programme sanitaire sur J1.
--
-- Le jour du démarrage est J1, pas J0. La vue calculait
-- date_debut + jour_debut, ce qui plaçait J1 au lendemain du démarrage et
-- décalait tout le calendrier d'un jour — les vaccins comme les retards.

BEGIN;

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
  (v.id IS NOT NULL)                                              AS confirme,
  v.date_saisie                                                   AS date_faite,
  (
    v.id IS NULL
    AND (b.date_debut::date + coalesce(ps.jour_fin, ps.jour_debut) - 1) < current_date
  ) AS en_retard
FROM bandes b
CROSS JOIN programme_sanitaire ps
LEFT JOIN vaccinations v
  ON v.bande_id = b.id
 AND lower(v.vaccin_nom) = lower(ps.nom)
 AND v.jour_bande BETWEEN ps.jour_debut AND coalesce(ps.jour_fin, ps.jour_debut);

COMMIT;
