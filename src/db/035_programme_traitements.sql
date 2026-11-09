-- Les traitements du programme sanitaire n'avaient aucun moyen d'être
-- confirmés, et le poids mesuré ne remontait nulle part.
--
-- LE DÉFAUT (signalé par Ndeye et Mengué, 9 nov. 2026).
-- Le programme compte trois sortes d'actes : vaccin, pesage, traitement.
-- La vue savait confirmer les deux premiers — un vaccin par la table des
-- vaccinations, un pesage par celle des pesages — mais le traitement
-- était jugé sur la table des VACCINATIONS, par correspondance de nom.
-- Un acte « Vitamine / Antistress » n'y figure évidemment jamais : il
-- restait « En retard » à perpétuité, même parfaitement administré.
-- Sur une ferme réelle, 9 actes sur 14 apparaissaient en retard alors
-- que le travail avait été fait.
--
-- CE QUI SERT DE PREUVE. L'application du responsable ne lui propose nulle
-- part de déclarer un traitement : elle ne l'invite qu'à la vaccination et
-- au pesage. Sa seule trace est « Produits utilisés », où il déclare ce
-- qu'il a sorti du stock. C'est donc là qu'il faut chercher — décision
-- prise avec Ndeye le 9 nov. 2026, contre l'ajout d'un écran de
-- confirmation qui lui demanderait un geste de plus chaque jour pour une
-- information qu'il donne déjà.
--
-- COMMENT ON RELIE UN PRODUIT À UN ACTE. Deux chemins, et c'est voulu :
--
--   1. les produits nommés dans l'acte (« Covit », « Aliseryl »,
--      « Anticox ») — c'est le chemin principal, et le seul possible pour
--      l'anticoccidien, absent du catalogue : le responsable le saisit en
--      « autre produit », au nom libre ;
--
--   2. la famille du catalogue déduite du NOM de l'acte (« Vitamine » →
--      vitamines, « Antistress » → antistress) — parce que le catalogue
--      ne nomme pas les marques : il ne connaît que « Pot 1 kg » et
--      « Sachet 100 g » sous la famille « vitamines ». Sans ce second
--      chemin, un responsable qui sort un pot de vitamines du catalogue
--      ne confirmerait aucun acte.
--
-- POURQUOI PAS UNE COLONNE « familles » SUR L'ACTE. Elle serait plus
-- explicite, mais l'admin crée et modifie librement les actes depuis son
-- écran Programme : une colonne qu'aucun formulaire ne remplit arriverait
-- vide au premier acte ajouté, et la détection retomberait en panne sans
-- que personne ne comprenne pourquoi. Les deux chemins ci-dessus ne
-- dépendent que de ce que l'admin saisit déjà.
--
-- LE PESAGE. Le poids mesuré était enregistré (pesages.poids_g, avec
-- l'indication s'il tombe dans la fourchette attendue) mais la vue ne le
-- rapportait pas : l'acte s'affichait « Fait », sans le chiffre. On
-- l'ajoute en fin de liste.
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
         WHEN 'pesage'     THEN pe.id IS NOT NULL
         WHEN 'traitement' THEN t.date_saisie IS NOT NULL
         ELSE                   v.id IS NOT NULL
       END AS confirme,
       CASE pa.type
         WHEN 'pesage'     THEN pe.date_saisie
         WHEN 'traitement' THEN t.date_saisie
         ELSE                   v.date_saisie
       END AS date_faite,
       (CASE pa.type
          WHEN 'pesage'     THEN pe.id IS NULL
          WHEN 'traitement' THEN t.date_saisie IS NULL
          ELSE                   v.id IS NULL
        END
        AND (b.date_debut::date + COALESCE(pa.jour_fin, pa.jour_debut) - 1) < CURRENT_DATE) AS en_retard,
       -- Ajoutées en fin de liste : CREATE OR REPLACE VIEW ne sait
       -- qu'ajouter des colonnes à la suite, jamais en insérer au milieu.
       pe.poids_g AS poids_mesure_g,
       pe.dans_fourchette
  FROM bandes b
  JOIN programme_actes_bande pa ON pa.bande_id = b.id
  LEFT JOIN vaccinations v
    ON pa.type = 'vaccin' AND v.bande_id = b.id
   AND lower(v.vaccin_nom) = lower(pa.nom)
   AND v.jour_bande >= pa.jour_debut
   AND v.jour_bande <= COALESCE(pa.jour_fin, pa.jour_debut)
  LEFT JOIN pesages pe
    ON pa.type = 'pesage' AND pe.bande_id = b.id AND pe.jour_bande = pa.jour_debut
  -- Le premier produit de l'acte sorti du stock pendant sa période. On
  -- garde la date la plus ancienne : un traitement donné du J1 au J5 est
  -- fait le jour où il commence, pas le jour où il finit.
  LEFT JOIN LATERAL (
    SELECT min(pu.date_saisie) AS date_saisie
      FROM produits_utilises pu
      LEFT JOIN stock_produits sp        ON sp.id  = pu.stock_produit_id
      LEFT JOIN stock_autres_produits sa ON sa.id  = pu.stock_autre_produit_id
     WHERE pu.bande_id = b.id
       AND (pu.date_saisie - b.date_debut::date + 1)
             BETWEEN pa.jour_debut AND COALESCE(pa.jour_fin, pa.jour_debut)
       AND (
         -- 1. un produit nommé dans l'acte, au catalogue ou en nom libre
         EXISTS (
           SELECT 1 FROM unnest(pa.produits) AS marque
            WHERE COALESCE(sp.nom, sa.nom) ILIKE '%' || marque || '%'
         )
         -- 2. la famille du catalogue déduite du nom de l'acte
         OR (sp.produit_id = 'vitamines'  AND pa.nom ILIKE '%vitamine%')
         OR (sp.produit_id = 'antistress' AND pa.nom ILIKE '%antistress%')
       )
  ) t ON pa.type = 'traitement';
