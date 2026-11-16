-- Une vaccination se compte en flacons, pas en doses.
--
-- CE QUI N'ALLAIT PAS (Ndeye, 16 nov. 2026). Le serveur calculait un
-- besoin en doses arrondi au multiple de 500, et retirait ce nombre de
-- doses du stock. Mais un flacon ne se divise pas : on l'ouvre et on
-- l'utilise. Son image : un comprimé de 1 000 mg ne se coupe pas en deux
-- parce qu'il en faudrait 500.
--
-- Conséquence, des messages incompréhensibles pour qui tient des flacons
-- dans la main — « 19 900 doses de moins que les 20 000 nécessaires »
-- quand il fallait lire « il te manque 1 flacon ».
--
-- Le stock reste tenu en doses : c'est la seule unité qui permette de
-- mélanger des flacons de 500 et de 1 000 du même vaccin. Mais tout ce
-- qui se décide et tout ce qui s'affiche se compte désormais en flacons,
-- et le décompte retire des flacons entiers.
--
-- On garde la contenance utilisée ce jour-là : sans elle, « 4 000 doses
-- retirées » ne dit pas s'il s'agit de 4 flacons de 1 000 ou de 8 de 500,
-- et l'alerte envoyée à SEDAP ne saurait pas quoi écrire.
--
-- Pas de BEGIN/COMMIT : migrate.js enveloppe déjà chaque fichier.

ALTER TABLE vaccinations
  ADD COLUMN IF NOT EXISTS doses_par_flacon integer;

ALTER TABLE vaccinations
  ADD COLUMN IF NOT EXISTS flacons_utilises integer;

ALTER TABLE vaccinations
  ADD COLUMN IF NOT EXISTS flacons_necessaires integer;
