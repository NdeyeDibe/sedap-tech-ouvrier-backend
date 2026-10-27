-- L'abonnement descend de la ferme au poulailler.
--
-- POURQUOI CE DÉPLACEMENT (objection Ndeye, 27 oct. 2026).
-- Un propriétaire de quatre poulaillers n'en abonne pas forcément quatre,
-- et pas forcément au même pack : il peut prendre JARIN sur son grand
-- bâtiment et XAM sur le petit. Le pack posé sur la ferme imposait le
-- même abonnement à tout le monde.
--
-- Deux autres choses le confirmaient déjà : le tarif se calcule par
-- bande, et une bande appartient à un poulailler ; et la caméra JARIN,
-- payée sur dix bandes, s'installe dans un bâtiment précis.
--
-- CE QUI EST REPRIS DE LA FERME. Les poulaillers existants héritent du
-- pack et de la date d'ouverture de leur ferme : c'était l'information
-- disponible, et elle reste vraie pour les fermes qui n'ont qu'un seul
-- abonnement. SEDAP corrigera poulailler par poulailler.
--
-- LES COLONNES DE `fermes` NE SONT PAS SUPPRIMÉES. Plus personne ne les
-- lit, mais les effacer rendrait tout retour en arrière impossible si la
-- reprise se passait mal. À supprimer dans une migration ultérieure, une
-- fois la nouvelle organisation éprouvée en production.
--
-- Pas de BEGIN/COMMIT : migrate.js enveloppe déjà chaque fichier.

ALTER TABLE poulaillers
  ADD COLUMN IF NOT EXISTS pack text,
  ADD COLUMN IF NOT EXISTS abonnement_debut date;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'poulaillers_pack_connu') THEN
    ALTER TABLE poulaillers
      ADD CONSTRAINT poulaillers_pack_connu
      CHECK (pack IS NULL OR pack IN ('xam', 'jamm', 'jarin'));
  END IF;
END $$;

UPDATE poulaillers pl
   SET pack = COALESCE(pl.pack, f.pack),
       abonnement_debut = COALESCE(pl.abonnement_debut, f.abonnement_debut, pl.cree_le::date)
  FROM fermes f
 WHERE f.id = pl.ferme_id
   AND (pl.pack IS NULL OR pl.abonnement_debut IS NULL);

-- Les poulaillers hérités des tests n'ont pas de ferme : ils n'ont donc
-- rien à hériter, mais leur date d'ouverture reste celle de leur création.
UPDATE poulaillers
   SET abonnement_debut = cree_le::date
 WHERE abonnement_debut IS NULL;
