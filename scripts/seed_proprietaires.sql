-- Jeu de données de test — deux propriétaires et leurs fermes.
-- À jouer une fois. Rejouable sans dégât : rien n'est dupliqué.
--
-- Comptes neutres, volontairement distincts des comptes ouvriers portant
-- les mêmes noms : pendant les tests, deux comptes homonymes de rôles
-- différents prêtent à confusion.
--
-- AVANT DE LANCER : remplace les deux adresses e-mail ci-dessous par de
-- vraies adresses, sinon tu ne pourras pas tester l'identification par mail.

\set email_un   'proprietaire1@example.com'
\set email_deux 'proprietaire2@example.com'

BEGIN;

-- Les jetons d'activation tiennent lieu du lien que SEDAP enverra par
-- mail et WhatsApp. Ici en clair pour pouvoir les recopier ; en production
-- ils seront tirés au hasard côté serveur.
INSERT INTO proprietaires (telephone, email, nom, prenom, jeton_activation, jeton_expire_le)
VALUES
  ('+221770000010', :'email_un',   'Un',   'Propriétaire', 'activation-un',   now() + interval '72 hours'),
  ('+221770000011', :'email_deux', 'Deux', 'Propriétaire', 'activation-deux', now() + interval '72 hours')
ON CONFLICT (telephone) DO NOTHING;

-- Une ferme par propriétaire.
INSERT INTO fermes (proprietaire_id, nom)
SELECT p.id, 'Ferme 1'
  FROM proprietaires p
 WHERE p.telephone = '+221770000010'
   AND NOT EXISTS (SELECT 1 FROM fermes f WHERE f.proprietaire_id = p.id);

INSERT INTO fermes (proprietaire_id, nom)
SELECT p.id, 'Ferme 2'
  FROM proprietaires p
 WHERE p.telephone = '+221770000011'
   AND NOT EXISTS (SELECT 1 FROM fermes f WHERE f.proprietaire_id = p.id);

-- Les poulaillers existants n'appartenaient à aucune ferme : on les
-- rattache à la première, pour que l'interface propriétaire ait de quoi
-- afficher dès la première connexion.
UPDATE poulaillers
   SET ferme_id = (
     SELECT f.id FROM fermes f
       JOIN proprietaires p ON p.id = f.proprietaire_id
      WHERE p.telephone = '+221770000010'
   )
 WHERE ferme_id IS NULL;

-- Chaque ouvrier déjà en base devient le responsable de son poulailler,
-- avec un salaire à définir — c'est au propriétaire de le renseigner.
INSERT INTO personnel (ferme_id, poulailler_id, ouvrier_id, role, prenom, telephone, salaire, prise_fonction)
SELECT pl.ferme_id, pl.id, o.id, 'responsable',
       coalesce(o.prenom, o.nom, 'Ouvrier'), o.telephone, NULL, current_date
  FROM poulaillers pl
  JOIN ouvriers o ON o.id = pl.ouvrier_id
 WHERE pl.ferme_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM personnel pe
      WHERE pe.poulailler_id = pl.id AND pe.role = 'responsable' AND pe.fin_fonction IS NULL
   );

COMMIT;

\echo ''
\echo '=== propriétaires ==='
SELECT id, prenom, nom, telephone, email, jeton_activation FROM proprietaires ORDER BY id;
\echo '=== fermes et poulaillers ==='
SELECT f.nom AS ferme, count(pl.id) AS poulaillers
  FROM fermes f LEFT JOIN poulaillers pl ON pl.ferme_id = f.id
 GROUP BY f.nom ORDER BY f.nom;
\echo '=== personnel ==='
SELECT pe.prenom, pe.role, pe.salaire, pl.nom AS poulailler
  FROM personnel pe LEFT JOIN poulaillers pl ON pl.id = pe.poulailler_id
 ORDER BY pe.id;
