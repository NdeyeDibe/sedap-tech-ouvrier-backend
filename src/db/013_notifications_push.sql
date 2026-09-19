-- Notifications push de l'interface propriétaire.
--
-- abonnements_push : un téléphone (ou navigateur) qui a accepté de recevoir
-- les notifications. Un même propriétaire peut en avoir plusieurs.
--
-- alertes_notifiees : journal des alertes déjà envoyées. La surveillance
-- repasse toutes les 15 minutes ; sans ce journal, la même alerte serait
-- renvoyée à chaque passage. Une alerte qui persiste est renvoyée une fois
-- par jour, et une alerte qui s'aggrave (surveiller → urgent) l'est aussitôt.

BEGIN;

CREATE TABLE IF NOT EXISTS abonnements_push (
  id SERIAL PRIMARY KEY,
  proprietaire_id INT NOT NULL REFERENCES proprietaires(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  -- Réglages de l'écran Profil (ex. {"mortalite": false}) : un type absent
  -- ou à true est envoyé.
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  maj_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS abonnements_push_proprietaire
  ON abonnements_push (proprietaire_id);

CREATE TABLE IF NOT EXISTS alertes_notifiees (
  proprietaire_id INT NOT NULL REFERENCES proprietaires(id) ON DELETE CASCADE,
  bande_id INT NOT NULL REFERENCES bandes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  cle TEXT NOT NULL,
  niveau TEXT NOT NULL,
  jour DATE NOT NULL DEFAULT current_date,
  envoye_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (proprietaire_id, bande_id, type, cle, niveau, jour)
);

COMMIT;
