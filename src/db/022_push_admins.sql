-- Notifications push pour les admins — cahier admin, maquette 19.
--
-- Les abonnements push existaient déjà, mais réservés aux propriétaires.
-- SEDAP en a besoin aussi : c'est elle qui doit être prévenue d'une alerte
-- urgente ou d'une saisie manquante, y compris application fermée.
--
-- On réutilise la table plutôt que d'en créer une seconde : l'envoi, la
-- purge des abonnements périmés et les préférences par type sont déjà
-- écrits une fois (services/notificationsPush.js). Deux tables voudraient
-- dire deux fois ce code, et un jour un correctif appliqué à une seule.
--
-- Un abonnement appartient donc soit à un propriétaire, soit à un admin,
-- jamais aux deux et jamais à personne.
--
-- Pas de BEGIN/COMMIT : migrate.js joue déjà chaque fichier dans une
-- transaction.

ALTER TABLE abonnements_push
  ADD COLUMN IF NOT EXISTS admin_id INTEGER REFERENCES admins(id) ON DELETE CASCADE;

ALTER TABLE abonnements_push ALTER COLUMN proprietaire_id DROP NOT NULL;

-- L'un ou l'autre, jamais les deux : sans cette règle, un abonnement sans
-- destinataire resterait en base à ne jamais rien recevoir, et un
-- abonnement à deux noms enverrait deux fois la même notification.
ALTER TABLE abonnements_push DROP CONSTRAINT IF EXISTS un_seul_destinataire;
ALTER TABLE abonnements_push ADD CONSTRAINT un_seul_destinataire
  CHECK ((proprietaire_id IS NULL) <> (admin_id IS NULL));

CREATE INDEX IF NOT EXISTS abonnements_push_admin
  ON abonnements_push (admin_id) WHERE admin_id IS NOT NULL;

-- Le même garde-fou que pour les propriétaires : une alerte déjà notifiée
-- ne repart pas à chaque passage de la surveillance (toutes les 15 min).
-- La clé inclut le niveau et le jour : une alerte qui passe orange → rouge
-- est une nouvelle notification, et une alerte qui dure se rappelle une
-- fois par jour, pas quatre fois par heure.
CREATE TABLE IF NOT EXISTS alertes_notifiees_admins (
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  bande_id INTEGER NOT NULL REFERENCES bandes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  cle TEXT NOT NULL,
  niveau TEXT NOT NULL,
  jour DATE NOT NULL DEFAULT CURRENT_DATE,
  envoye_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (admin_id, bande_id, type, cle, niveau, jour)
);
