-- Suivi des alertes côté SEDAP — cahier admin, maquettes 05 et 06.
--
-- Les alertes ne sont pas stockées : elles se recalculent à chaque appel à
-- partir de l'état réel des bandes. C'est voulu — une alerte stockée peut
-- rester affichée alors que la situation est réglée depuis trois jours.
--
-- Mais SEDAP a besoin de savoir ce qu'elle a déjà traité, sinon la liste
-- redonne chaque matin les mêmes lignes qu'hier et on finit par ne plus la
-- lire du tout. D'où cette table : elle ne stocke pas les alertes, elle
-- stocke ce que SEDAP en a fait.
--
-- L'identité d'une alerte est (bande, type, clé) — les trois existent déjà
-- dans utils/alertes.js, où elles servent à ne notifier le propriétaire
-- qu'une fois par alerte.
--
-- Deux règles portées par cette table :
--
--  1. « Traitée » et « Ignorée » ne changent QUE la liste de SEDAP. Le
--     propriétaire continue de voir son alerte tant que la situation dure
--     (maquette 06) : la marquer traitée ne règle rien sur le terrain.
--
--  2. Une alerte qui s'aggrave redevient « À traiter ». D'où la colonne
--     `niveau` : on garde le niveau du moment où la décision a été prise,
--     et on la compare au niveau courant. Une mortalité « à surveiller »
--     qu'on a ignorée hier et qui passe « urgent » aujourd'hui doit
--     remonter, sinon on ignore une urgence sans le savoir.
--
-- Pas de BEGIN/COMMIT : migrate.js joue déjà chaque fichier dans une
-- transaction.

CREATE TABLE IF NOT EXISTS suivis_alertes (
  id SERIAL PRIMARY KEY,
  bande_id INTEGER NOT NULL REFERENCES bandes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  cle TEXT NOT NULL,
  niveau TEXT NOT NULL CHECK (niveau IN ('surveiller', 'urgent')),
  etat TEXT NOT NULL CHECK (etat IN ('traitee', 'ignoree')),
  motif TEXT,
  admin_id INTEGER REFERENCES admins(id),
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Une seule décision courante par alerte : reclasser remplace.
  CONSTRAINT une_decision_par_alerte UNIQUE (bande_id, type, cle),

  -- Ignorer sans dire pourquoi ne laisse rien d'exploitable à celui qui
  -- relira la liste la semaine suivante (maquette 06, motif obligatoire).
  CONSTRAINT ignorer_motive CHECK (etat <> 'ignoree' OR motif IS NOT NULL)
);

-- La liste des alertes joint ce suivi bande par bande.
CREATE INDEX IF NOT EXISTS suivis_alertes_bande ON suivis_alertes (bande_id);
