-- Supprime des comptes propriétaires de test et tout ce qui n'existe que
-- pour eux — sans jamais toucher aux poulaillers ni à leur production.
--
-- Renseigne ici les téléphones des comptes à supprimer.

\set cible1 '+221770000010'
\set cible2 '+221770000011'

BEGIN;

-- Détacher les poulaillers avant toute chose : la clé étrangère est
-- désormais en SET NULL, mais on le fait explicitement pour que l'effet
-- soit lisible.
UPDATE poulaillers SET ferme_id = NULL
 WHERE ferme_id IN (
   SELECT f.id FROM fermes f JOIN proprietaires p ON p.id = f.proprietaire_id
    WHERE p.telephone IN (:'cible1', :'cible2')
 );

-- Le personnel n'existe que par la ferme : il part avec elle.
DELETE FROM personnel
 WHERE ferme_id IN (
   SELECT f.id FROM fermes f JOIN proprietaires p ON p.id = f.proprietaire_id
    WHERE p.telephone IN (:'cible1', :'cible2')
 );

DELETE FROM frais
 WHERE ferme_id IN (
   SELECT f.id FROM fermes f JOIN proprietaires p ON p.id = f.proprietaire_id
    WHERE p.telephone IN (:'cible1', :'cible2')
 );

DELETE FROM fermes
 WHERE proprietaire_id IN (
   SELECT id FROM proprietaires WHERE telephone IN (:'cible1', :'cible2')
 );

DELETE FROM proprietaires WHERE telephone IN (:'cible1', :'cible2');

COMMIT;

\echo ''
\echo '=== propriétaires restants ==='
SELECT id, prenom, nom, telephone FROM proprietaires ORDER BY id;
\echo '=== poulaillers (doivent tous être intacts) ==='
SELECT id, nom, ferme_id FROM poulaillers ORDER BY id;
