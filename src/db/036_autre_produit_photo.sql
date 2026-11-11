-- Photographier un produit plutôt que l'écrire.
--
-- POURQUOI (demande Mengué, 11 nov. 2026). Les responsables peinent à
-- saisir le nom d'un « autre produit » : ils lisent et écrivent peu, et
-- le nom est le seul champ libre de toute l'application. Résultat, des
-- noms approximatifs — « Norflo » pour Norfloxacine — que le propriétaire
-- ne reconnaît pas sur sa facture, quand le produit n'est pas simplement
-- abandonné en cours de saisie.
--
-- Le responsable photographie donc le produit, et saisit ce qu'il sait
-- faire : des chiffres. Le nom est mis plus tard par quelqu'un qui lit —
-- le propriétaire sur ses réceptions, ou SEDAP depuis l'admin.
--
-- NOM FACULTATIF, MAIS JAMAIS RIEN. La contrainte NOT NULL sur `nom`
-- disparaît, remplacée par une règle plus juste : une réception porte un
-- nom OU une photo. Sans cela, une ligne pourrait arriver sans aucun
-- moyen d'identifier le produit — ni lisible, ni reconnaissable — et
-- personne ne pourrait plus la rattraper. La contrainte le rend
-- impossible au niveau de la base, pas seulement dans l'application.
--
-- LA PHOTO EST UNE ADRESSE, PAS UN FICHIER. Elle vit sur Cloudinary,
-- comme les photos de mortalité. Hors réseau, l'application garde le
-- fichier dans le téléphone et envoie une adresse provisoire que la file
-- d'attente remplace au retour du réseau — ce mécanisme existe déjà et
-- fonctionne pour n'importe quel champ.
--
-- Pas de BEGIN/COMMIT : migrate.js enveloppe déjà chaque fichier.

ALTER TABLE stock_autres_produits
  ADD COLUMN IF NOT EXISTS photo_url text;

ALTER TABLE stock_autres_produits
  ALTER COLUMN nom DROP NOT NULL;

-- Un nom vide vaut un nom absent : sans cette normalisation, une chaîne
-- vide passerait la contrainte ci-dessous tout en n'identifiant rien.
UPDATE stock_autres_produits SET nom = NULL WHERE btrim(nom) = '';

ALTER TABLE stock_autres_produits
  DROP CONSTRAINT IF EXISTS autre_nom_ou_photo;

ALTER TABLE stock_autres_produits
  ADD CONSTRAINT autre_nom_ou_photo
  CHECK (nom IS NOT NULL OR photo_url IS NOT NULL);

-- La vue des réceptions porte la photo : c'est elle que lisent l'écran du
-- propriétaire et celui de l'admin, et sans la photo ils n'auraient aucun
-- moyen de nommer le produit. Nulle pour le catalogue et les poussins,
-- qui n'en ont pas besoin — leur nom est connu d'avance.
CREATE OR REPLACE VIEW receptions_ferme AS
  SELECT 'produit'::text AS origine,
         sr.id,
         sp.poulailler_id,
         sp.produit_id AS poste,
         sp.nom,
         sp.unite,
         sr.quantite_recue AS quantite,
         sr.prix_unitaire,
         sr.provenance,
         sr.date_reception,
         sr.source,
         (SELECT b.id FROM bandes b
           WHERE b.poulailler_id = sp.poulailler_id
             AND sr.date_reception >= b.date_debut
             AND (b.date_fin IS NULL OR sr.date_reception <= b.date_fin)
           ORDER BY b.date_debut DESC LIMIT 1) AS bande_id,
         NULL::text AS photo_url
    FROM stock_receptions sr
    JOIN stock_produits sp ON sp.id = sr.stock_produit_id
  UNION ALL
  SELECT 'autre'::text AS origine,
         sap.id,
         sap.poulailler_id,
         'autres'::character varying AS poste,
         sap.nom,
         'unités'::character varying AS unite,
         sap.quantite_recue AS quantite,
         sap.prix_unitaire,
         NULL::character varying AS provenance,
         sap.date_reception,
         sap.source,
         (SELECT b.id FROM bandes b
           WHERE b.poulailler_id = sap.poulailler_id
             AND sap.date_reception >= b.date_debut
             AND (b.date_fin IS NULL OR sap.date_reception <= b.date_fin)
           ORDER BY b.date_debut DESC LIMIT 1) AS bande_id,
         sap.photo_url
    FROM stock_autres_produits sap
  UNION ALL
  SELECT 'poussins'::text AS origine,
         b.id,
         b.poulailler_id,
         'poussins'::character varying AS poste,
         'Poussins'::character varying AS nom,
         'sujets'::character varying AS unite,
         COALESCE(b.poussins_commandes, b.poussins_recus)::numeric(10, 2) AS quantite,
         b.prix_unitaire_poussin AS prix_unitaire,
         b.provenance,
         b.date_debut AS date_reception,
         b.poussins_paye_par AS source,
         b.id AS bande_id,
         NULL::text AS photo_url
    FROM bandes b;
