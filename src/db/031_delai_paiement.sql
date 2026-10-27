-- Délai accordé à la main sur une facture.
--
-- Le verrou tombe automatiquement passé les délais (services/verrou.js).
-- Il faut pourtant une soupape : un bon client en déplacement, un éleveur
-- qui a payé en espèces à un commercial, une panne de l'agrégateur. Sans
-- elle, SEDAP n'aurait d'autre choix que d'enregistrer un faux paiement
-- pour débloquer quelqu'un — et le registre des encaissements mentirait.
--
-- Une date, pas un booléen : un délai « jusqu'au 3 novembre » se périme
-- tout seul. Un drapeau « débloqué » resterait vrai pour toujours, et la
-- ferme ne se reverrouillerait jamais.
--
-- Pas de BEGIN/COMMIT : migrate.js enveloppe déjà chaque fichier.

ALTER TABLE factures
  ADD COLUMN IF NOT EXISTS delai_jusquau timestamptz,
  ADD COLUMN IF NOT EXISTS delai_motif text,
  ADD COLUMN IF NOT EXISTS delai_par integer REFERENCES admins(id) ON DELETE SET NULL;

-- Le moment où SEDAP a fixé le montant d'une facture « sur devis ».
-- C'est de là que part le délai de paiement pour ces factures-là : on ne
-- peut pas reprocher à un éleveur de ne pas avoir payé une somme qu'il
-- n'avait pas encore reçue.
ALTER TABLE factures
  ADD COLUMN IF NOT EXISTS montant_fixe_le timestamptz;
