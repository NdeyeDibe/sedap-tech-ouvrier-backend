-- Recalage de la durée des bandes sur J1.
--
-- Même décalage que pour l'âge et le programme : une simple différence de
-- dates comptait le jour du démarrage comme zéro. Une bande démarrée
-- aujourd'hui affichait 0 jour, et une bande de 25 jours en affichait 24 —
-- alors que c'est bien à J25 que la vente s'ouvre côté ouvrier.

BEGIN;

CREATE OR REPLACE VIEW bilans_bandes AS
SELECT
  b.id AS bande_id,
  b.poulailler_id,
  b.numero,
  b.statut,
  b.date_debut,
  b.date_fin,
  (coalesce(b.date_fin, now())::date - b.date_debut::date + 1) AS duree_jours,
  e.morts,
  e.vendus,
  e.taux_mortalite,
  coalesce((SELECT sum(d.cout) FROM depenses_bandes d WHERE d.bande_id = b.id), 0)
    AS total_depenses,
  r.recettes AS total_recettes,
  r.sujets_sans_prix,
  r.recettes
    - coalesce((SELECT sum(d.cout) FROM depenses_bandes d WHERE d.bande_id = b.id), 0)
    AS benefice_net
FROM bandes b
LEFT JOIN etat_bandes e ON e.bande_id = b.id
LEFT JOIN recettes_bandes r ON r.bande_id = b.id;

COMMIT;
