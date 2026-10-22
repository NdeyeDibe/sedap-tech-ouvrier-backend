-- Abonnement de la ferme : quel pack, et depuis quand.
--
-- Jusqu'ici la plateforme ne savait rien de l'offre commerciale. Pour
-- facturer en janvier, il faut deux renseignements par ferme, et deux
-- seulement : le pack souscrit, et la date d'ouverture du compte, qui
-- fait partir les 4 mois gratuits (fiche d'offre, « La période
-- gratuite »).
--
-- Ce qui n'est PAS stocké, et ne doit pas l'être : la fin de la période
-- gratuite et le montant dû. Les deux se calculent à partir d'ici et de
-- la grille tarifaire (services/abonnement.js). Une date de fin figée en
-- base deviendrait fausse le jour où la date de début est corrigée.
--
-- Pas de BEGIN/COMMIT : migrate.js enveloppe déjà chaque fichier.

ALTER TABLE fermes
  ADD COLUMN IF NOT EXISTS pack text,
  ADD COLUMN IF NOT EXISTS abonnement_debut date;

-- Trois packs, pas un de plus : une faute de frappe dans l'admin ne doit
-- pas créer un quatrième pack silencieusement. NULL reste permis — une
-- ferme enregistrée avant la souscription n'a pas encore de pack.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fermes_pack_connu') THEN
    ALTER TABLE fermes
      ADD CONSTRAINT fermes_pack_connu
      CHECK (pack IS NULL OR pack IN ('xam', 'jamm', 'jarin'));
  END IF;
END $$;

-- Les fermes déjà en base ont ouvert leur compte le jour de leur création :
-- c'est la date exacte, pas une estimation. SEDAP peut la corriger depuis
-- la fiche de la ferme si l'accord commercial a été signé un autre jour.
-- Le pack, lui, reste vide : c'est un choix commercial, personne ne peut
-- le deviner à la place de l'éleveur.
UPDATE fermes
   SET abonnement_debut = cree_le::date
 WHERE abonnement_debut IS NULL;
