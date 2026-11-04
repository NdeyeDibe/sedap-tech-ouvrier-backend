-- Un responsable retiré de son poste ne se connecte plus.
--
-- POURQUOI (demande Mengué, 4 nov. 2026). « Retirer du poste » détachait
-- le responsable de son poulailler, mais son compte restait ouvert : il
-- pouvait encore se connecter. L'application ne lui montrait rien — tout
-- passe par son poulailler, et il n'en avait plus — mais pour un départ
-- conflictuel, un renvoi ou un abandon de poste, un accès qui s'ouvre
-- encore est inacceptable. Et quand un remplaçant arrive, deux personnes
-- ne doivent pas pouvoir entrer dans la même application.
--
-- UNE COLONNE À PART, ET PAS compte_verrouille.
-- `compte_verrouille` veut dire « trois codes faux » : le message, le
-- remède (déverrouiller) et la responsabilité ne sont pas les mêmes.
-- Les confondre rendrait l'écran admin incompréhensible — on ne saurait
-- plus si un compte est bloqué parce que l'ouvrier s'est trompé ou
-- parce que SEDAP l'a retiré.
--
-- UNE DATE, PAS UN BOOLÉEN : on veut savoir depuis quand, comme pour
-- verrouille_le et suspendu_le ailleurs dans le schéma.
--
-- Pas de BEGIN/COMMIT : migrate.js enveloppe déjà chaque fichier.

ALTER TABLE ouvriers
  ADD COLUMN IF NOT EXISTS retire_le timestamptz;

-- Les responsables déjà retirés avant aujourd'hui : leur ligne personnel
-- porte une fin de fonction et ils n'ont aucun poste en cours. Leur
-- compte doit être fermé lui aussi, sinon la règle ne vaudrait que pour
-- les départs à venir.
UPDATE ouvriers o
   SET retire_le = (
     SELECT max(pe.fin_fonction)::timestamptz
       FROM personnel pe
      WHERE pe.ouvrier_id = o.id AND pe.role = 'responsable'
   )
 WHERE o.retire_le IS NULL
   AND EXISTS (
     SELECT 1 FROM personnel pe
      WHERE pe.ouvrier_id = o.id AND pe.role = 'responsable' AND pe.fin_fonction IS NOT NULL
   )
   AND NOT EXISTS (
     SELECT 1 FROM personnel pe
      WHERE pe.ouvrier_id = o.id AND pe.role = 'responsable' AND pe.fin_fonction IS NULL
   );
