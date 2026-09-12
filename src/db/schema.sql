-- Schéma de base de données — SEDAP'Tech (interface ouvrier)
-- Reprend fidèlement toute la logique déjà construite côté frontend
-- (actuellement simulée avec des données factices en mémoire dans
-- src/lib/*Mock.js et *Store.js du projet React).
--
-- Convention : noms de tables et colonnes en français, comme le reste
-- du projet (CDC, commentaires de code), pour rester cohérent.

-- ============================================================
-- OUVRIERS (comptes utilisateurs) — CDC section II
-- ============================================================
CREATE TABLE IF NOT EXISTS ouvriers (
  id SERIAL PRIMARY KEY,
  telephone VARCHAR(20) UNIQUE NOT NULL,
  -- pin_hash est NULL tant que l'ouvrier n'a pas encore créé son code :
  -- le compte est d'abord créé par le PROPRIÉTAIRE (nom, prénom,
  -- téléphone) depuis SON interface — l'ouvrier ne fait que définir son
  -- PIN sur ce compte déjà existant, jamais créer un compte lui-même.
  pin_hash VARCHAR(255), -- jamais le PIN en clair, toujours haché (bcrypt)
  nom VARCHAR(100),
  prenom VARCHAR(100),
  tentatives_echouees INT NOT NULL DEFAULT 0, -- pour la règle "3 tentatives -> compte verrouillé"
  compte_verrouille BOOLEAN NOT NULL DEFAULT FALSE,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- CREDENTIALS_WEBAUTHN — clés Face ID / empreinte digitale
-- enregistrées par un ouvrier pour se connecter sans retaper son PIN
-- (CDC : confort d'usage, le PIN reste toujours disponible en repli).
-- Une même personne peut en avoir plusieurs (ex: change de téléphone).
-- ============================================================
CREATE TABLE IF NOT EXISTS credentials_webauthn (
  id SERIAL PRIMARY KEY,
  ouvrier_id INT NOT NULL REFERENCES ouvriers(id) ON DELETE CASCADE,
  identifiant_credential TEXT UNIQUE NOT NULL, -- fourni par le téléphone, encodé base64url
  cle_publique TEXT NOT NULL, -- clé publique, encodée base64url (jamais la biométrie elle-même)
  compteur BIGINT NOT NULL DEFAULT 0, -- protection anti-rejeu fournie par WebAuthn
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- POULAILLERS — un ouvrier gère un poulailler (CDC : "un seul
-- poulailler = un seul ouvrier = une seule bande active à la fois")
-- ============================================================
CREATE TABLE IF NOT EXISTS poulaillers (
  id SERIAL PRIMARY KEY,
  ouvrier_id INT NOT NULL REFERENCES ouvriers(id) ON DELETE CASCADE,
  nom VARCHAR(100), -- optionnel, ex: "Poulailler A"
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- BANDES — CDC section III/IV
-- ============================================================
CREATE TABLE IF NOT EXISTS bandes (
  id SERIAL PRIMARY KEY,
  poulailler_id INT NOT NULL REFERENCES poulaillers(id) ON DELETE CASCADE,
  numero INT NOT NULL, -- numéro de bande pour ce poulailler (1, 2, 3...)
  statut VARCHAR(20) NOT NULL DEFAULT 'en_cours' CHECK (statut IN ('en_cours', 'terminee')),
  poussins_commandes INT,
  poussins_recus INT NOT NULL,
  morts_a_larrivee INT NOT NULL DEFAULT 0,
  provenance VARCHAR(100), -- couvoir fournisseur
  souche VARCHAR(100), -- optionnel
  poids_reception_g INT, -- poids moyen à la réception, doit être >= 35g (avertissement, pas bloquant)
  date_debut TIMESTAMPTZ NOT NULL DEFAULT now(),
  date_fin TIMESTAMPTZ, -- rempli seulement quand statut = 'terminee'
  UNIQUE (poulailler_id, numero)
);

-- Un seul index partiel pour garantir UNE SEULE bande "en_cours" par
-- poulailler à la fois (CDC III.3) — la BDD elle-même empêche l'erreur,
-- pas seulement l'interface.
CREATE UNIQUE INDEX IF NOT EXISTS une_seule_bande_active_par_poulailler
  ON bandes (poulailler_id)
  WHERE statut = 'en_cours';

-- ============================================================
-- SAISIES QUOTIDIENNES — CDC section V (Mortalité + Santé),
-- section VII (Alimentation) — une ligne par jour et par bande
-- ============================================================
CREATE TABLE IF NOT EXISTS saisies_mortalite (
  id SERIAL PRIMARY KEY,
  bande_id INT NOT NULL REFERENCES bandes(id) ON DELETE CASCADE,
  date_saisie DATE NOT NULL DEFAULT CURRENT_DATE,
  mortalite INT NOT NULL DEFAULT 0,
  photos TEXT[] NOT NULL DEFAULT '{}', -- liste de vraies URLs Cloudinary
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bande_id, date_saisie) -- une seule saisie mortalité par jour et par bande
);

CREATE TABLE IF NOT EXISTS saisies_sante (
  id SERIAL PRIMARY KEY,
  bande_id INT NOT NULL REFERENCES bandes(id) ON DELETE CASCADE,
  date_saisie DATE NOT NULL DEFAULT CURRENT_DATE,
  etat VARCHAR(20) NOT NULL CHECK (etat IN ('bien', 'anormal', 'urgent')),
  a_vocal BOOLEAN NOT NULL DEFAULT FALSE,
  photos TEXT[] NOT NULL DEFAULT '{}', -- liste de vraies URLs Cloudinary
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bande_id, date_saisie)
);

-- Une ligne par TYPE d'aliment utilisé ce jour-là (mélange possible,
-- ex: Démarrage + Croissance le même jour — voir décision Ndeye)
CREATE TABLE IF NOT EXISTS saisies_alimentation (
  id SERIAL PRIMARY KEY,
  bande_id INT NOT NULL REFERENCES bandes(id) ON DELETE CASCADE,
  date_saisie DATE NOT NULL DEFAULT CURRENT_DATE,
  type_aliment VARCHAR(30) NOT NULL CHECK (type_aliment IN ('demarrage', 'croissance', 'finition')),
  sacs NUMERIC(6,2) NOT NULL DEFAULT 0,
  kg_supplementaires NUMERIC(6,2) NOT NULL DEFAULT 0,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- VACCINATION / PESAGE — CDC section VI — hors parcours quotidien,
-- seulement certains jours précis du programme (voir décision Ndeye)
-- ============================================================
CREATE TABLE IF NOT EXISTS vaccinations (
  id SERIAL PRIMARY KEY,
  bande_id INT NOT NULL REFERENCES bandes(id) ON DELETE CASCADE,
  jour_bande INT NOT NULL, -- jour de la bande où le vaccin a été fait
  vaccin_nom VARCHAR(100) NOT NULL,
  date_saisie DATE NOT NULL DEFAULT CURRENT_DATE,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pesages (
  id SERIAL PRIMARY KEY,
  bande_id INT NOT NULL REFERENCES bandes(id) ON DELETE CASCADE,
  jour_bande INT NOT NULL,
  poids_g INT NOT NULL,
  dans_fourchette BOOLEAN NOT NULL,
  date_saisie DATE NOT NULL DEFAULT CURRENT_DATE,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- STOCK — CDC section VIII. Catalogue des produits + variantes,
-- quantité en stock suivie ici (aliment en KG précis, cf décision Mengué)
-- ============================================================
CREATE TABLE IF NOT EXISTS stock_produits (
  id SERIAL PRIMARY KEY,
  poulailler_id INT NOT NULL REFERENCES poulaillers(id) ON DELETE CASCADE,
  produit_id VARCHAR(30) NOT NULL, -- 'aliment' | 'gaz' | 'litiere' | 'vitamines' | 'antistress' | 'vaccin'
  variante_id VARCHAR(50) NOT NULL, -- ex: 'demarrage', '6kg', 'pot', 'gumboro_l'...
  nom VARCHAR(100) NOT NULL,
  unite VARCHAR(20) NOT NULL, -- 'kg' | 'bouteilles' | 'sacs' | 'unités' | 'doses'
  quantite NUMERIC(10,2) NOT NULL DEFAULT 0,
  UNIQUE (poulailler_id, produit_id, variante_id)
);

-- Historique des réceptions de stock (CDC VIII.2) — chaque réception
-- garde le prix unitaire payé, nécessaire pour le bilan financier (X)
CREATE TABLE IF NOT EXISTS stock_receptions (
  id SERIAL PRIMARY KEY,
  stock_produit_id INT NOT NULL REFERENCES stock_produits(id) ON DELETE CASCADE,
  quantite_recue NUMERIC(10,2) NOT NULL,
  prix_unitaire NUMERIC(10,2) NOT NULL,
  provenance VARCHAR(100), -- fournisseur (aliment uniquement pour l'instant)
  date_reception TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Produits utilisés" (Gaz/Litière/Vitamines/Antistress/Vaccin
-- consommés au quotidien, hors aliment — écran séparé, cf décision Ndeye)
CREATE TABLE IF NOT EXISTS produits_utilises (
  id SERIAL PRIMARY KEY,
  bande_id INT NOT NULL REFERENCES bandes(id) ON DELETE CASCADE,
  -- Exactement UN des deux doit être renseigné (jamais les deux, jamais
  -- aucun) — retour Ndeye : la catégorie "Autre" (nom libre, table à
  -- part) n'était jusqu'ici jamais utilisable ici, oubli corrigé.
  stock_produit_id INT REFERENCES stock_produits(id),
  stock_autre_produit_id INT REFERENCES stock_autres_produits(id),
  quantite NUMERIC(10,2) NOT NULL,
  date_saisie DATE NOT NULL DEFAULT CURRENT_DATE,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT un_seul_type_de_produit CHECK (
    (stock_produit_id IS NOT NULL AND stock_autre_produit_id IS NULL) OR
    (stock_produit_id IS NULL AND stock_autre_produit_id IS NOT NULL)
  )
);

-- "Autres produits" (nom libre, CDC VIII.2)
CREATE TABLE IF NOT EXISTS stock_autres_produits (
  id SERIAL PRIMARY KEY,
  poulailler_id INT NOT NULL REFERENCES poulaillers(id) ON DELETE CASCADE,
  nom VARCHAR(150) NOT NULL,
  quantite NUMERIC(10,2) NOT NULL,
  prix_unitaire NUMERIC(10,2) NOT NULL,
  date_reception TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- VENTES — CDC section IX
-- ============================================================
CREATE TABLE IF NOT EXISTS ventes (
  id SERIAL PRIMARY KEY,
  bande_id INT NOT NULL REFERENCES bandes(id) ON DELETE CASCADE,
  nom_client VARCHAR(150) NOT NULL,
  telephone_client VARCHAR(20),
  prix_unitaire NUMERIC(10,2) NOT NULL,
  quantite INT NOT NULL,
  date_vente TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Traçabilité de l'auteur (retour Mengué, sept. 2026) : le Propriétaire
  -- pourra lui aussi enregistrer des ventes une fois son interface prête
  -- — il faut donc déjà savoir QUI a fait quelle vente, pour que chacun
  -- ne puisse modifier que les siennes. Pas de clé étrangère vers une
  -- table "proprietaires" pour l'instant (elle n'existe pas encore).
  auteur_type VARCHAR(20) NOT NULL DEFAULT 'ouvrier' CHECK (auteur_type IN ('ouvrier', 'proprietaire')),
  auteur_ouvrier_id INT REFERENCES ouvriers(id)
);
