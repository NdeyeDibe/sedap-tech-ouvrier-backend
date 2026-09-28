-- Seuils d'alerte réglables — cahier admin, maquette 20.
--
-- Jusqu'ici les seuils étaient des constantes dans utils/alertes.js : pour
-- passer le taux de mortalité urgent de 0,5 % à 0,4 %, il fallait modifier
-- le code, redéployer, et espérer n'avoir rien cassé. SEDAP doit pouvoir le
-- faire elle-même — c'est son métier, pas le mien.
--
-- Une table clé/valeur plutôt que des colonnes nommées : ajouter un seuil
-- ne demandera pas de migration, seulement une ligne dans le catalogue de
-- services/seuils.js, qui décrit chaque clé, son type, ses bornes et sa
-- valeur d'origine. C'est là que vit la validation, pas ici : une borne
-- écrite en SQL ne dirait rien à l'écran qui la viole.
--
-- La valeur est du TEXTE. Les seuils mêlent des nombres (0,5 %), des
-- entiers (J7) et une heure (18:00) ; un type par colonne obligerait à
-- deviner lequel lire.
--
-- Les lignes absentes valent la valeur d'origine : la table ne contient que
-- ce que SEDAP a effectivement changé. « Revenir aux valeurs SEDAP »
-- (maquette 20) est donc un simple DELETE.
--
-- Pas de BEGIN/COMMIT : migrate.js joue déjà chaque fichier dans une
-- transaction.

CREATE TABLE IF NOT EXISTS parametres (
  cle TEXT PRIMARY KEY,
  valeur TEXT NOT NULL,
  modifie_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  modifie_par INTEGER REFERENCES admins(id)
);
