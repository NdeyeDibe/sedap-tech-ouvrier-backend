-- Programme sanitaire SEDAP — identique pour tous les poulaillers.
--
-- Jusqu'ici la table vaccinations n'enregistrait que ce qui avait été FAIT.
-- Un vaccin oublié ne laissait donc aucune trace : rien à afficher en rouge,
-- rien à alerter. Il manquait la liste de ce qui DOIT être fait.
--
-- Le programme étant le même partout, une seule table de référence suffit :
-- la date prévue se déduit du démarrage de chaque bande, sans rien recopier.
--
-- Deux natures cohabitent. Le CDC ne fait déclencher l'alerte que par les
-- vaccins ; les traitements (vitamine, antistress, anticoccidien) s'étalent
-- sur plusieurs jours et relèvent du confort de suivi.

BEGIN;

CREATE TABLE IF NOT EXISTS programme_sanitaire (
  id SERIAL PRIMARY KEY,
  nom VARCHAR(100) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('vaccin', 'traitement')),
  jour_debut INT NOT NULL,
  -- NULL quand l'acte tient sur un seul jour (un vaccin, typiquement).
  jour_fin INT,
  ordre INT NOT NULL,

  CONSTRAINT programme_ordre_unique UNIQUE (ordre),
  CONSTRAINT programme_jours_coherents
    CHECK (jour_fin IS NULL OR jour_fin >= jour_debut)
);

INSERT INTO programme_sanitaire (nom, type, jour_debut, jour_fin, ordre) VALUES
  ('Vitamine / Antistress', 'traitement',  1,    5, 1),
  ('Gumboro L',             'vaccin',      9, NULL, 2),
  ('Antistress',            'traitement',  9,   11, 3),
  ('Gumboro IBDL',          'vaccin',     14, NULL, 4),
  ('Antistress',            'traitement', 14,   16, 5),
  ('Anticoccidien',         'traitement', 18,   20, 6),
  ('Lasota',                'vaccin',     21, NULL, 7),
  ('Antistress',            'traitement', 21,   22, 8),
  ('Vitamine',              'traitement', 23,   25, 9)
ON CONFLICT (ordre) DO NOTHING;

-- Le programme d'une bande : chaque acte prévu, sa date, et s'il a été fait.
-- Un acte est « en retard » quand son dernier jour est passé sans confirmation.
CREATE OR REPLACE VIEW programme_bandes AS
SELECT
  b.id AS bande_id,
  ps.ordre,
  ps.nom,
  ps.type,
  ps.jour_debut,
  ps.jour_fin,
  (b.date_debut::date + ps.jour_debut)                        AS date_prevue,
  (b.date_debut::date + coalesce(ps.jour_fin, ps.jour_debut)) AS date_limite,
  (v.id IS NOT NULL)                                          AS confirme,
  v.date_saisie                                               AS date_faite,
  (
    v.id IS NULL
    AND (b.date_debut::date + coalesce(ps.jour_fin, ps.jour_debut)) < current_date
  ) AS en_retard
FROM bandes b
CROSS JOIN programme_sanitaire ps
LEFT JOIN vaccinations v
  ON v.bande_id = b.id
 AND lower(v.vaccin_nom) = lower(ps.nom)
 AND v.jour_bande BETWEEN ps.jour_debut AND coalesce(ps.jour_fin, ps.jour_debut);

COMMIT;
