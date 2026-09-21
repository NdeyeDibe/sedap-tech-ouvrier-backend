-- Journal d'activité — cahier admin v1.2, section X bis.
--
-- Une ligne par écriture faite par un admin, un propriétaire ou le système
-- (verrouillage automatique) : qui, quoi, sur quoi, quand, et les valeurs
-- avant/après. Pour une suppression, la ligne supprimée y est recopiée en
-- entier : c'est la seule trace qui en reste.
--
-- Remplace admin_journal (016), créé le même jour et qui ne contenait que
-- les créations d'ouvriers : une seule table donne la chronologie complète
-- d'un compte, actions de SEDAP et du propriétaire mêlées (maquette 12,
-- « Historique du compte »).
--
-- Pas de clés étrangères : une entrée doit survivre à ce qu'elle décrit —
-- une vente supprimée, un poulailler archivé. Les identifiants sont gardés
-- tels quels, le nom lisible est dans details.
--
-- Pas de BEGIN/COMMIT : migrate.js joue déjà chaque fichier dans une
-- transaction.

CREATE TABLE IF NOT EXISTS journal_activite (
  id BIGSERIAL PRIMARY KEY,
  acteur_type VARCHAR(20) NOT NULL
    CHECK (acteur_type IN ('admin', 'proprietaire', 'ouvrier', 'systeme')),
  acteur_id INT,                 -- NULL pour le système
  action VARCHAR(60) NOT NULL,   -- ex. 'vente_supprimee', 'salaire_modifie'

  -- Contexte, pour filtrer sans jointure : la fiche d'un propriétaire lit
  -- proprietaire_id, le détail d'une bande lit bande_id.
  proprietaire_id INT,
  ferme_id INT,
  poulailler_id INT,
  bande_id INT,

  cible_type VARCHAR(30),        -- 'vente', 'frais', 'personnel', 'reception', 'compte'…
  cible_id INT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS journal_activite_proprietaire
  ON journal_activite (proprietaire_id, cree_le DESC);
CREATE INDEX IF NOT EXISTS journal_activite_bande
  ON journal_activite (bande_id, cree_le DESC);
CREATE INDEX IF NOT EXISTS journal_activite_cible
  ON journal_activite (cible_type, cible_id);

-- Ni modifiable ni supprimable, y compris par l'admin principal (cahier X bis).
-- La base le garantit, pas seulement l'API.
CREATE OR REPLACE FUNCTION journal_activite_intouchable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Le journal d''activité ne se modifie pas et ne se supprime pas.';
END;
$$;

DROP TRIGGER IF EXISTS journal_activite_ajout_seul ON journal_activite;
CREATE TRIGGER journal_activite_ajout_seul
  BEFORE UPDATE OR DELETE ON journal_activite
  FOR EACH ROW EXECUTE FUNCTION journal_activite_intouchable();

-- Reprise de admin_journal, puis suppression de l'ancienne table.
DO $$
BEGIN
  IF to_regclass('public.admin_journal') IS NOT NULL THEN
    INSERT INTO journal_activite
      (acteur_type, acteur_id, action, poulailler_id, ferme_id, proprietaire_id,
       cible_type, cible_id, details, cree_le)
    SELECT 'admin', aj.admin_id,
           CASE aj.action WHEN 'ouvrier_cree' THEN 'ouvrier_responsable_cree' ELSE aj.action END,
           pl.id, pl.ferme_id, f.proprietaire_id,
           aj.cible_type, aj.cible_id, aj.details, aj.cree_le
      FROM admin_journal aj
      LEFT JOIN poulaillers pl ON pl.id = (aj.details->>'poulaillerId')::int
      LEFT JOIN fermes f ON f.id = pl.ferme_id;

    DROP TABLE admin_journal;
  END IF;
END $$;
