-- Retour Mengué (test terrain) : quand il n'y a pas de stock d'aliment,
-- l'ouvrier ne peut rien saisir dans "Alimentation" (aucun type
-- disponible), donc la table saisies_alimentation reste vide toute la
-- journée. Résultat : le dashboard considérait la journée comme "pas
-- encore faite" indéfiniment et renvoyait l'ouvrier en boucle sur cet
-- écran à chaque fois qu'il cliquait sur "Continuer la saisie du jour".
--
-- Cette table permet de distinguer "pas encore vu" de "vu aujourd'hui,
-- rien à déclarer" pour une étape donnée, sans polluer les tables de
-- vraies saisies (ex: saisies_alimentation garde un CHECK sur
-- type_aliment qui interdit une ligne "vide").
CREATE TABLE IF NOT EXISTS saisies_sans_donnee (
  id SERIAL PRIMARY KEY,
  bande_id INT NOT NULL REFERENCES bandes(id) ON DELETE CASCADE,
  date_saisie DATE NOT NULL DEFAULT CURRENT_DATE,
  etape VARCHAR(30) NOT NULL, -- ex: 'alimentation'
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bande_id, date_saisie, etape)
);
