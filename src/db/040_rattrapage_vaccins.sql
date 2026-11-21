-- Un vaccin déclaré par « Produits utilisés » confirme son acte.
--
-- CE QUI S'EST PASSÉ (bande n° 22, constaté le 21 nov. 2026). « Gumboro L »
-- est prévu à J9. Le 12 novembre — J9 — le responsable a sorti deux fois
-- 4 doses de Gumboro L par l'écran « Produits utilisés », faute de pouvoir
-- enregistrer la vaccination : le serveur la refusait alors par manque de
-- doses. L'acte a bien été administré, et il est resté « En retard » chez
-- le propriétaire comme chez SEDAP.
--
-- POURQUOI LA MIGRATION 037 NE SUFFISAIT PAS. Elle a ajouté ce rattrapage
-- par les produits utilisés, mais l'a branché avec `ON pa.type =
-- 'traitement'`. Or Gumboro L est de type 'vaccin'. Le rattrapage ne
-- pouvait donc jamais jouer pour les vaccins — précisément les actes que
-- l'ancien refus avait fait passer par cet écran. Gumboro IBDL à J14 est
-- confirmé parce qu'il a, lui, une vraie vaccination enregistrée.
--
-- POURQUOI C'EST SANS RISQUE POUR L'AVENIR. Les vaccins, vitamines et
-- antistress ont été retirés de « Produits utilisés » le 14 novembre :
-- aucune nouvelle ligne de ce genre ne peut plus naître. Ce rattrapage ne
-- regarde donc que le passé, et il s'éteindra de lui-même avec les bandes
-- qui l'ont connu.
--
-- CE QUE ÇA NE FAIT PAS. L'antistress de J9-J11 de cette même bande reste
-- en retard, et c'est juste : rien n'a été sorti du stock dans sa fenêtre
-- — les vitamines de J12 sont un autre produit. Un acte réellement oublié
-- doit se déclarer explicitement, pas se deviner.
--
-- Pas de BEGIN/COMMIT : migrate.js enveloppe déjà chaque fichier.

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
  -- Jusqu'où cet acte peut-il encore être confirmé : la veille de l'acte
  -- suivant portant le même nom, sans limite s'il n'y en a pas d'autre.
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
  -- Un acte déclaré sur l'écran du programme : vaccin, mais aussi vitamine
  -- ou antistress, qui passent désormais par le même écran.
  LEFT JOIN vaccinations v
    ON pa.type <> 'pesage' AND v.bande_id = b.id
   AND lower(v.vaccin_nom) = lower(pa.nom)
   AND v.jour_bande >= pa.jour_debut
   AND v.jour_bande <= f.jour_butoir
  LEFT JOIN pesages pe
    ON pa.type = 'pesage' AND pe.bande_id = b.id AND pe.jour_bande = pa.jour_debut
  -- Le produit sorti du stock pendant la période. Vaut pour TOUT acte qui
  -- n'est pas un pesage — c'est le seul changement par rapport à la 037,
  -- qui le réservait aux traitements et laissait les vaccins de côté.
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
         -- Le nom du produit en stock porte celui du vaccin : « Gumboro L »
         -- sorti du stock confirme l'acte « Gumboro L ». On compare au nom
         -- de l'acte et non à sa liste de marques, qui peut être vide.
         OR (sp.produit_id = 'vaccin'     AND COALESCE(sp.nom, '') ILIKE pa.nom)
         OR (sp.produit_id = 'vitamines'  AND pa.nom ILIKE '%vitamine%')
         OR (sp.produit_id = 'antistress' AND pa.nom ILIKE '%antistress%')
       )
  ) t ON pa.type <> 'pesage';
