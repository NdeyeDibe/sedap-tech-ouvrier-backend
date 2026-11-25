-- Déclarer un traitement : vitamines, antistress, anticoccidien.
--
-- POURQUOI CETTE MIGRATION. Le 14 novembre, vaccins, vitamines et
-- antistress ont été retirés de l'écran « Produits utilisés » : ils
-- relèvent du programme sanitaire, pas de la consommation courante. Mais
-- seuls les vaccins ont reçu un écran de remplacement. Depuis cette date,
-- aucun traitement ne peut plus être déclaré par qui que ce soit, et
-- chaque vitamine, chaque antistress du programme part en retard pour
-- toujours (constaté le 22 nov. 2026).
--
-- CE QU'ON STOCKE, ET OÙ. Un traitement déclaré est un acte du programme
-- réalisé, exactement comme une vaccination : même table `vaccinations`,
-- dont `vaccin_nom` porte le nom de l'acte. C'est ce que la vue
-- programme_bandes lit déjà pour tout acte qui n'est pas un pesage — rien
-- à changer de ce côté.
--
-- DEUX COLONNES MANQUAIENT. Un vaccin se compte en flacons et en doses,
-- un traitement en pots ou en sachets : il fallait une quantité dans
-- l'unité du produit. Et surtout, le programme prévoit un
-- « Anticoccidien » à J18-J20 alors qu'aucun anticoccidien n'existe au
-- catalogue du stock — le responsable l'achète en pharmacie et le déclare
-- dans « autres produits ». Sans lien vers cette table, cet acte-là
-- resterait indéclarable.
--
-- Pas de BEGIN/COMMIT : migrate.js enveloppe déjà chaque fichier.

ALTER TABLE vaccinations
  ADD COLUMN IF NOT EXISTS stock_autre_produit_id INT
    REFERENCES stock_autres_produits(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS quantite_utilisee NUMERIC(12,2);

COMMENT ON COLUMN vaccinations.quantite_utilisee IS
  'Ce qui a été retiré du stock, dans l''unité du produit : des doses pour '
  'un vaccin, des pots ou des sachets pour un traitement. NULL sur les '
  'lignes antérieures au 23 nov. 2026, qui ne déduisaient rien.';

COMMENT ON COLUMN vaccinations.stock_autre_produit_id IS
  'Renseigné quand le produit vient des « autres produits » du responsable '
  '— un anticoccidien de pharmacie, par exemple — et non du catalogue. '
  'Exclusif avec stock_produit_id.';

-- Un acte puise dans UN produit : celui du catalogue ou l'un des siens,
-- jamais les deux. Sans cette garde, une ligne pourrait déduire deux
-- stocks pour un seul traitement.
ALTER TABLE vaccinations
  DROP CONSTRAINT IF EXISTS vaccinations_un_seul_produit;
ALTER TABLE vaccinations
  ADD CONSTRAINT vaccinations_un_seul_produit
  CHECK (stock_produit_id IS NULL OR stock_autre_produit_id IS NULL);

-- Un même acte ne se déclare qu'une fois. Le responsable qui tape deux
-- fois sur le bouton, ou dont la requête part deux fois depuis la file
-- d'attente hors ligne, déduirait sinon le stock en double — c'est
-- exactement ce qui est arrivé au Gumboro L de la bande 22, sorti deux
-- fois le même jour.
--
-- ON DÉDOUBLONNE AVANT DE POSER L'INDEX. Une contrainte unique posée sur
-- une table qui la viole déjà échoue, et comme les migrations tournent au
-- démarrage du serveur, l'API ne s'ouvrirait pas du tout — c'est la panne
-- du 17 novembre. On garde la première déclaration de chaque acte et on
-- supprime les suivantes.
--
-- CE QUE ÇA NE RÉPARE PAS : le stock déjà déduit deux fois reste déduit
-- deux fois. Supprimer la ligne en double ne rend pas les doses. Si des
-- lignes disparaissent ici, les quantités correspondantes sont à vérifier
-- depuis l'écran des réceptions de l'admin.
DELETE FROM vaccinations v
 WHERE EXISTS (
   SELECT 1 FROM vaccinations plus_ancienne
    WHERE plus_ancienne.bande_id = v.bande_id
      AND lower(plus_ancienne.vaccin_nom) = lower(v.vaccin_nom)
      AND plus_ancienne.jour_bande = v.jour_bande
      AND plus_ancienne.id < v.id
 );

CREATE UNIQUE INDEX IF NOT EXISTS vaccinations_acte_unique
  ON vaccinations (bande_id, lower(vaccin_nom), jour_bande);
