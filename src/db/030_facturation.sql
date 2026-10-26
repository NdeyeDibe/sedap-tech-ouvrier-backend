-- Facturation à la bande : une facture par bande, et ses encaissements.
--
-- POURQUOI UNE FACTURE PAR BANDE, ÉMISE À L'OUVERTURE.
-- L'offre facture « par bande » et le paiement est d'avance (décision
-- Mengué/Ndeye, 25 oct. 2026) : la facture naît le jour où la bande
-- s'ouvre, sur l'effectif déclaré à ce moment-là. Elle ne bouge plus
-- ensuite — la mortalité des semaines suivantes ne change pas le prix,
-- sinon l'éleveur ne saurait jamais ce qu'il doit avant la fin.
--
-- CE QUI N'EST PAS STOCKÉ : l'état « payée / partielle / impayée ». Il se
-- déduit de la somme des paiements. Une colonne `statut` tenue à jour à la
-- main finit toujours par mentir le jour où un paiement est corrigé.
--
-- MONTANT NULL. Ce n'est pas zéro. C'est « la grille ne répond pas » :
-- au-delà de 12 000 sujets l'offre dit « sur devis », et certaines cases
-- ne sont pas commercialisées (JAMM sous 500 sujets, JARIN sous 1 500).
-- Le motif dit lequel des deux, et SEDAP fixe le montant à la main.
--
-- LES BANDES GRATUITES N'ONT PAS DE FACTURE DU TOUT. « Une bande ouverte
-- pendant ces 4 mois reste gratuite jusqu'à sa clôture » : pas de ligne à
-- 0 F, qui encombrerait la liste des impayés.
--
-- Pas de BEGIN/COMMIT : migrate.js enveloppe déjà chaque fichier.

CREATE TABLE IF NOT EXISTS factures (
  id              serial PRIMARY KEY,
  ferme_id        integer NOT NULL REFERENCES fermes(id) ON DELETE CASCADE,
  -- Une bande, une facture. L'unicité est la garantie qu'un redémarrage
  -- du serveur ou un double appel ne facture pas deux fois la même bande.
  bande_id        integer NOT NULL UNIQUE REFERENCES bandes(id) ON DELETE CASCADE,
  pack            text NOT NULL,
  -- Sujets vivants au démarrage : reçus moins morts à l'arrivée.
  effectif        integer NOT NULL,
  -- Combien de bandes cette ferme avait déjà fait facturer, plus un.
  -- Sert à JARIN : la caméra est comprise sur les 10 premières.
  rang            integer NOT NULL,
  tranche         text,
  montant         integer,
  motif           text,
  camera_comprise boolean NOT NULL DEFAULT false,
  emise_le        date NOT NULL DEFAULT current_date,
  -- Une facture ne se supprime pas : elle s'annule, en gardant sa trace.
  annulee_le      timestamptz,
  annulee_motif   text,
  cree_le         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS factures_ferme ON factures (ferme_id);

-- Plusieurs encaissements possibles pour une facture : un éleveur peut
-- payer en deux fois, et SEDAP doit pouvoir le constater plutôt que de
-- devoir choisir entre « payé » et « impayé ».
CREATE TABLE IF NOT EXISTS paiements (
  id         serial PRIMARY KEY,
  facture_id integer NOT NULL REFERENCES factures(id) ON DELETE CASCADE,
  montant    integer NOT NULL CHECK (montant > 0),
  moyen      text NOT NULL,
  -- Référence de la transaction Wave / Orange Money, ou du reçu. C'est
  -- elle qui permettra de rapprocher les encaissements le jour où un
  -- agrégateur remplira cette table tout seul.
  reference  text,
  recu_le    date NOT NULL DEFAULT current_date,
  saisi_par  integer REFERENCES admins(id) ON DELETE SET NULL,
  cree_le    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paiements_facture ON paiements (facture_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paiements_moyen_connu') THEN
    ALTER TABLE paiements
      ADD CONSTRAINT paiements_moyen_connu
      CHECK (moyen IN ('wave', 'orange_money', 'free_money', 'especes', 'virement', 'autre'));
  END IF;
END $$;
