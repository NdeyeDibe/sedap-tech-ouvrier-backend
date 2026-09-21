-- « personnel » devient la seule référence du lien ouvrier ↔ poulailler,
-- et la structure reçoit les champs que demande le cahier admin v1.1.
--
-- Jusqu'ici ce lien existait à deux endroits : poulaillers.ouvrier_id (lu par
-- toute l'API ouvrier) et personnel (lu par le propriétaire et les alertes).
-- Trois choses du cahier admin étaient impossibles avec ouvrier_id NOT NULL :
--   * ajouter un poulailler avant de lui affecter un responsable ;
--   * retirer un responsable et lui couper l'accès (VII) ;
--   * supprimer un compte ouvrier sans emporter le poulailler, ses bandes et
--     ses saisies — le ON DELETE CASCADE le faisait sans prévenir.
--
-- poulaillers.ouvrier_id n'est pas supprimé : il reste le repli des 4
-- poulaillers hérités qui n'ont pas encore de ferme (personnel exige une
-- ferme). À retirer une fois ces poulaillers rattachés depuis l'interface.
--
-- Pas de BEGIN/COMMIT : migrate.js joue déjà chaque fichier dans une
-- transaction.

-- ============================================================
-- 1. Le lien devient facultatif et ne détruit plus rien
-- ============================================================
ALTER TABLE poulaillers ALTER COLUMN ouvrier_id DROP NOT NULL;

ALTER TABLE poulaillers DROP CONSTRAINT IF EXISTS poulaillers_ouvrier_id_fkey;
ALTER TABLE poulaillers
  ADD CONSTRAINT poulaillers_ouvrier_id_fkey
  FOREIGN KEY (ouvrier_id) REFERENCES ouvriers(id) ON DELETE SET NULL;

-- Côté personnel, le lien vers le compte ne doit surtout pas s'effacer tout
-- seul : personnel porte une contrainte « un responsable a un compte », et un
-- ON DELETE SET NULL la violait — la suppression échouait sur un message
-- incompréhensible. En RESTRICT, la base dit clairement qu'un compte encore
-- rattaché à un poulailler ne se supprime pas : l'admin le retire d'abord
-- (fin de fonction), conformément au cahier (VII).
ALTER TABLE personnel DROP CONSTRAINT IF EXISTS personnel_ouvrier_id_fkey;
ALTER TABLE personnel
  ADD CONSTRAINT personnel_ouvrier_id_fkey
  FOREIGN KEY (ouvrier_id) REFERENCES ouvriers(id) ON DELETE RESTRICT;

-- ============================================================
-- 2. Reprise : une ligne personnel pour chaque responsable qui n'en a pas
--    encore. Sans ferme, la ligne est impossible : ces poulaillers-là
--    gardent le repli sur ouvrier_id jusqu'à leur rattachement.
-- ============================================================
INSERT INTO personnel (ferme_id, poulailler_id, ouvrier_id, role, prenom, telephone, salaire, prise_fonction)
SELECT pl.ferme_id, pl.id, o.id, 'responsable',
       coalesce(o.prenom, o.nom, 'Ouvrier'), o.telephone, NULL, current_date
  FROM poulaillers pl
  JOIN ouvriers o ON o.id = pl.ouvrier_id
 WHERE pl.ferme_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM personnel pe
      WHERE pe.poulailler_id = pl.id
        AND pe.role = 'responsable'
        AND pe.fin_fonction IS NULL
   );

-- ============================================================
-- 3. Un ouvrier n'est responsable que d'un seul poulailler à la fois.
--    La base le garantit, plutôt que les trois interfaces séparément.
-- ============================================================
DO $$
DECLARE
  v_doublons TEXT;
BEGIN
  SELECT string_agg(ouvrier_id::text, ', ') INTO v_doublons
    FROM (
      SELECT ouvrier_id FROM personnel
       WHERE role = 'responsable' AND fin_fonction IS NULL AND ouvrier_id IS NOT NULL
       GROUP BY ouvrier_id HAVING count(*) > 1
    ) d;

  IF v_doublons IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration arrêtée : ouvrier(s) % responsable(s) de plusieurs poulaillers. À trancher avant de continuer.',
      v_doublons;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS un_poulailler_par_responsable
  ON personnel (ouvrier_id)
  WHERE role = 'responsable' AND fin_fonction IS NULL AND ouvrier_id IS NOT NULL;

-- Lecture faite à chaque appel de l'API ouvrier : elle doit être directe.
CREATE INDEX IF NOT EXISTS personnel_ouvrier_en_poste
  ON personnel (ouvrier_id)
  WHERE fin_fonction IS NULL;

-- ============================================================
-- 4. Champs manquants du cahier admin
-- ============================================================

-- VII : l'e-mail du propriétaire devient facultatif (recommandé seulement
-- pour ceux qui vivent à l'étranger). L'unicité reste : PostgreSQL autorise
-- plusieurs NULL dans une colonne UNIQUE.
ALTER TABLE proprietaires ALTER COLUMN email DROP NOT NULL;

-- VII : « Nom de la ferme, localité (obligatoires) » au formulaire de
-- création. Nullable en base : les fermes déjà enregistrées n'en ont pas.
ALTER TABLE fermes ADD COLUMN IF NOT EXISTS localite VARCHAR(150);

-- VIII : capacité maximale affichée sous chaque poulailler, et archivage —
-- un poulailler qui a déjà eu une bande ne se supprime pas, il disparaît des
-- listes mais garde son historique dans les rapports.
ALTER TABLE poulaillers ADD COLUMN IF NOT EXISTS capacite INT
  CHECK (capacite IS NULL OR capacite > 0);
ALTER TABLE poulaillers ADD COLUMN IF NOT EXISTS archive_le TIMESTAMPTZ;
