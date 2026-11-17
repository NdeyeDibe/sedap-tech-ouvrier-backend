-- Une vaccination s'enregistre même quand les doses manquent, et un acte
-- fait en retard reste un acte fait.
--
-- CE QUI S'EST PASSÉ (bande n° 1 du Bâtiment 1, constaté le 14 nov. 2026).
-- 4 flacons de 1 000 doses reçus, 4 092 sujets vivants. Le serveur
-- arrondit le besoin au multiple de 500 supérieur, soit 4 500 doses, et
-- refusait la vaccination faute de stock. Le responsable, bloqué, est
-- allé marquer « 4 » dans « Produits utilisés » — deux fois. Résultat :
-- 8 doses retirées d'un flacon de 4 000, aucune vaccination enregistrée,
-- et l'acte « Gumboro L » qui reste « à faire » chez le propriétaire
-- jusqu'à la fin de la bande.
--
-- Trois défauts se cumulaient, et il faut les traiter ensemble :
--
--   1. le refus pur et simple ne laissait aucune issue. Désormais on
--      déduit ce qui reste et on enregistre l'acte, en gardant trace de
--      l'écart — décision de Ndeye, 14 nov. 2026 : une bande vaccinée
--      avec trop peu de doses reste une bande vaccinée, et SEDAP doit le
--      savoir plutôt que de ne rien voir du tout ;
--
--   2. « Produits utilisés » faisait sortir le vaccin du stock sans rien
--      enregistrer. Les produits du programme en sont retirés côté
--      application ;
--
--   3. la fenêtre de confirmation tenait sur le seul jour prévu. Gumboro L
--      prévu à J9 et fait à J10 ne confirmait rien, et l'alerte restait
--      rouge à vie.
--
-- Pas de BEGIN/COMMIT : migrate.js enveloppe déjà chaque fichier.

-- Ce qui a réellement été utilisé, et ce qu'il aurait fallu. Les deux,
-- parce que l'écart est l'information : il dit à SEDAP qu'une bande a été
-- vaccinée à court de doses, ce qu'aucun stock ne raconte après coup.
ALTER TABLE vaccinations
  ADD COLUMN IF NOT EXISTS doses_utilisees integer;

ALTER TABLE vaccinations
  ADD COLUMN IF NOT EXISTS doses_necessaires integer;

-- La fenêtre de confirmation s'étend jusqu'à la veille de l'acte suivant
-- portant le même nom, et sans limite s'il n'y en a pas d'autre.
--
-- POURQUOI PAS UNE SIMPLE TOLÉRANCE DE QUELQUES JOURS. « Antistress »
-- revient trois fois dans le programme — J9-J11, J14-J16, J21-J22. Une
-- tolérance fixe de trois jours ferait déborder la première sur la
-- deuxième, et un seul antistress en confirmerait deux. Se borner à
-- l'occurrence suivante évite ce chevauchement sans rien inventer.
--
-- Le RETARD, lui, continue de se juger sur la date prévue : être confirmé
-- tardivement ne rend pas l'acte ponctuel.
CREATE OR REPLACE VIEW programme_bandes AS
SELECT b.id AS bande_id,
       pa.ordre,
       pa.nom,
       pa.type,
       pa.jour_debut,
       pa.jour_fin,
       pa.produits,
       pa.administration,
       pa.poids_min_g,
       pa.poids_max_g,
       b.date_debut::date + pa.jour_debut - 1 AS date_prevue,
       b.date_debut::date + COALESCE(pa.jour_fin, pa.jour_debut) - 1 AS date_limite,
       CASE pa.type
         WHEN 'pesage' THEN pe.id IS NOT NULL
         ELSE v.id IS NOT NULL OR t.date_saisie IS NOT NULL
       END AS confirme,
       CASE pa.type
         WHEN 'pesage' THEN pe.date_saisie
         ELSE COALESCE(v.date_saisie, t.date_saisie)
       END AS date_faite,
       (CASE pa.type
          WHEN 'pesage' THEN pe.id IS NULL
          ELSE v.id IS NULL AND t.date_saisie IS NULL
        END
        AND (b.date_debut::date + COALESCE(pa.jour_fin, pa.jour_debut) - 1) < CURRENT_DATE) AS en_retard,
       pe.poids_g AS poids_mesure_g,
       pe.dans_fourchette
  FROM bandes b
  JOIN programme_actes_bande pa ON pa.bande_id = b.id
  -- Jusqu'où cet acte peut-il encore être confirmé.
  LEFT JOIN LATERAL (
    SELECT COALESCE(
             (SELECT min(pa2.jour_debut) - 1
                FROM programme_actes_bande pa2
               WHERE pa2.bande_id = pa.bande_id
                 AND lower(pa2.nom) = lower(pa.nom)
                 AND pa2.jour_debut > pa.jour_debut),
             2147483647
           ) AS jour_butoir
  ) f ON true
  -- Un acte déclaré sur l'écran du programme : vaccin, mais aussi
  -- vitamine ou antistress, qui passent désormais par le même écran.
  LEFT JOIN vaccinations v
    ON pa.type <> 'pesage' AND v.bande_id = b.id
   AND lower(v.vaccin_nom) = lower(pa.nom)
   AND v.jour_bande >= pa.jour_debut
   AND v.jour_bande <= f.jour_butoir
  LEFT JOIN pesages pe
    ON pa.type = 'pesage' AND pe.bande_id = b.id AND pe.jour_bande = pa.jour_debut
  -- Le produit sorti du stock pendant la période. Conservé pour les
  -- traitements déjà déclarés ainsi avant ce changement : les retirer
  -- ferait repasser en rouge des actes réellement faits.
  LEFT JOIN LATERAL (
    SELECT min(pu.date_saisie) AS date_saisie
      FROM produits_utilises pu
      LEFT JOIN stock_produits sp        ON sp.id = pu.stock_produit_id
      LEFT JOIN stock_autres_produits sa ON sa.id = pu.stock_autre_produit_id
     WHERE pu.bande_id = b.id
       AND (pu.date_saisie - b.date_debut::date + 1)
             BETWEEN pa.jour_debut AND f.jour_butoir
       AND (
         EXISTS (
           SELECT 1 FROM unnest(pa.produits) AS marque
            WHERE COALESCE(sp.nom, sa.nom) ILIKE '%' || marque || '%'
         )
         OR (sp.produit_id = 'vitamines'  AND pa.nom ILIKE '%vitamine%')
         OR (sp.produit_id = 'antistress' AND pa.nom ILIKE '%antistress%')
       )
  ) t ON pa.type = 'traitement';
