-- La fenêtre de rattrapage se ferme au prochain acte que le même PRODUIT
-- pourrait confirmer, et non au prochain acte portant le même NOM.
--
-- CE QUI N'ALLAIT PAS. La vue confirme un acte quand le produit
-- correspondant sort du stock. Pour savoir jusqu'à quand, elle cherchait
-- le prochain acte « portant exactement le même nom » et fermait la
-- fenêtre la veille. Or le programme nomme l'acte de J1-J5
-- « Vitamine / Antistress », puis « Antistress » à J9, J14, J21 et
-- « Vitamine » à J23. Aucun ne porte le même nom : la fenêtre du J1 ne se
-- fermait donc jamais.
--
-- CE QUE ÇA DONNAIT. Le responsable ne fait rien au J1-J5, l'acte reste
-- rouge — puis des vitamines sortent du stock au J12 pour autre chose, et
-- l'acte J1-J5 passe au vert tout seul. Vert, il disparaît des rattrapages
-- de SEDAP : la bande a l'air en règle sur un acte jamais administré. Un
-- faux vert est pire qu'un rouge, parce qu'il n'appelle personne.
--
-- LA RÈGLE MAINTENANT. Deux actes se disputent le même produit quand ils
-- portent le même nom, quand ils partagent une marque, ou quand tous deux
-- parlent de vitamine ou tous deux d'antistress — c'est-à-dire exactement
-- dans les cas où la sortie de stock pourrait confirmer l'un ou l'autre.
-- La fenêtre d'un acte se ferme la veille du premier de ceux-là. Pour le
-- programme de Mengué, « Vitamine / Antistress » J1-J5 partage Covit et
-- Aliseryl avec l'antistress de J9 et Amintotal avec la vitamine de J23 :
-- sa fenêtre se referme au J8.
--
-- CE QUE ÇA NE RÈGLE PAS, ET C'EST VOULU. Un vaccin qui n'apparaît qu'une
-- fois dans le programme n'a aucun acte suivant pour fermer sa fenêtre :
-- elle reste ouverte jusqu'à la fin de la bande. Mettre une borne
-- arbitraire — sept jours, dix jours — reviendrait à inventer une règle
-- que personne n'a tranchée. À voir avec Mengué si le cas se présente.
--
-- EFFET AU DÉPLOIEMENT. Sur les bandes en cours, les actes devenus verts
-- par un produit sorti hors fenêtre repassent au rouge. Ce n'est pas une
-- régression : c'est la vérité qui revient, et ces actes-là sont à
-- rattraper depuis la fiche de la bande.
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
  -- Jusqu'où cet acte peut-il encore être confirmé : la veille du prochain
  -- acte que le même produit pourrait confirmer. Sans limite s'il n'y en a
  -- aucun — un vaccin qui n'apparaît qu'une fois dans le programme.
  LEFT JOIN LATERAL (
    SELECT COALESCE(
             (SELECT min(pa2.jour_debut) - 1
                FROM programme_actes_bande pa2
               WHERE pa2.bande_id = pa.bande_id
                 AND pa2.jour_debut > pa.jour_debut
                 AND pa2.type <> 'pesage'
                 AND (
                   -- Même acte, répété plus tard dans le programme.
                   lower(pa2.nom) = lower(pa.nom)
                   -- Une marque en commun : le même flacon sorti du stock
                   -- confirmerait l'un comme l'autre. C'est le cas de
                   -- « Vitamine / Antistress » et de « Antistress », qui
                   -- partagent Covit et Aliseryl.
                   OR EXISTS (
                        SELECT 1
                          FROM unnest(pa.produits)  AS m1
                          JOIN unnest(pa2.produits) AS m2 ON lower(m1) = lower(m2)
                      )
                   -- Les deux voies par catégorie de stock : un produit
                   -- rangé en « vitamines » confirme tout acte dont le nom
                   -- parle de vitamine, idem pour l'antistress.
                   OR (pa.nom ILIKE '%vitamine%'   AND pa2.nom ILIKE '%vitamine%')
                   OR (pa.nom ILIKE '%antistress%' AND pa2.nom ILIKE '%antistress%')
                 )),
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
  -- n'est pas un pesage.
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
