-- Propriétaire de test unique pour Railway.
--
-- Il possède tous les poulaillers existants : pendant la phase de test, les
-- testeurs partagent une seule ferme. À découper en plusieurs fermes le jour
-- où chacun doit ne voir que la sienne.
--
-- AVANT DE LANCER : remplace l'adresse e-mail ci-dessous.

\set email 'proprietaire.test@example.com'

BEGIN;

INSERT INTO proprietaires (telephone, email, nom, prenom, jeton_activation, jeton_expire_le)
VALUES ('+221770000010', :'email', 'Test', 'Propriétaire',
        'activation-test', now() + interval '30 days')
ON CONFLICT (telephone) DO NOTHING;

INSERT INTO fermes (proprietaire_id, nom)
SELECT p.id, 'Ferme de test'
  FROM proprietaires p
 WHERE p.telephone = '+221770000010'
   AND NOT EXISTS (SELECT 1 FROM fermes f WHERE f.proprietaire_id = p.id);

-- Tous les poulaillers sans ferme lui sont rattachés.
UPDATE poulaillers
   SET ferme_id = (
     SELECT f.id FROM fermes f
       JOIN proprietaires p ON p.id = f.proprietaire_id
      WHERE p.telephone = '+221770000010'
   )
 WHERE ferme_id IS NULL;

-- Chaque ouvrier devient responsable de son poulailler, salaire à définir :
-- c'est au propriétaire de le renseigner depuis son interface.
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

COMMIT;

\echo ''
\echo '=== propriétaire ==='
SELECT id, prenom, nom, telephone, email, jeton_activation FROM proprietaires;
\echo '=== poulaillers rattachés ==='
SELECT count(*) AS poulaillers, count(ferme_id) AS avec_ferme FROM poulaillers;
\echo '=== personnel ==='
SELECT pe.prenom, pe.role, pe.salaire, pl.nom AS poulailler
  FROM personnel pe LEFT JOIN poulaillers pl ON pl.id = pe.poulailler_id
 ORDER BY pe.id;
