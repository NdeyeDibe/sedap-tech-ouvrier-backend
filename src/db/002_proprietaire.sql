-- SEDAP'Tech — extension pour l'interface propriétaire et la phase de vente.
-- Additif : ne recrée rien de l'existant, complète ce qui manque.
--
-- Décisions de septembre 2026 que ce fichier concrétise :
--   * une ferme appartient à un propriétaire, et regroupe ses poulaillers ;
--   * deux sortes d'ouvriers — le responsable, qui a un compte créé par
--     SEDAP, et les simples, sans compte, que le propriétaire ajoute pour
--     ses charges ;
--   * « Démarrer la vente » ouvre une phase au lieu de clore la bande ;
--   * un ramassage part sans prix, le propriétaire l'éclate ensuite.

BEGIN;

-- ==========================================================
-- PROPRIÉTAIRES — même forme que ouvriers, pour que le code
-- d'authentification existant se transpose sans surprise.
-- Nul ne s'inscrit : SEDAP crée le compte et envoie un lien
-- par mail ET WhatsApp, d'où l'e-mail obligatoire.
-- ==========================================================
CREATE TABLE IF NOT EXISTS proprietaires (
  id SERIAL PRIMARY KEY,
  telephone VARCHAR(20) UNIQUE NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  nom VARCHAR(100),
  prenom VARCHAR(100),
  pin_hash VARCHAR(255),
  tentatives_echouees INT NOT NULL DEFAULT 0,
  compte_verrouille BOOLEAN NOT NULL DEFAULT FALSE,
  -- Le lien d'activation : à usage unique et daté. C'est lui le secret,
  -- puisqu'il ne parvient qu'aux coordonnées enregistrées par SEDAP.
  jeton_activation TEXT UNIQUE,
  jeton_expire_le TIMESTAMPTZ,
  activee_le TIMESTAMPTZ,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Le Face ID doit servir aux deux rôles : on ouvre la table existante
-- au propriétaire plutôt que d'en créer une seconde, identique.
ALTER TABLE credentials_webauthn
  ALTER COLUMN ouvrier_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS proprietaire_id INT REFERENCES proprietaires(id) ON DELETE CASCADE;

ALTER TABLE credentials_webauthn
  DROP CONSTRAINT IF EXISTS credential_un_seul_titulaire;
ALTER TABLE credentials_webauthn
  ADD CONSTRAINT credential_un_seul_titulaire CHECK (
    (ouvrier_id IS NOT NULL AND proprietaire_id IS NULL) OR
    (ouvrier_id IS NULL AND proprietaire_id IS NOT NULL)
  );

-- ==========================================================
-- FERMES — 1 propriétaire -> 1 ferme -> plusieurs poulaillers
-- ==========================================================
CREATE TABLE IF NOT EXISTS fermes (
  id SERIAL PRIMARY KEY,
  proprietaire_id INT NOT NULL REFERENCES proprietaires(id) ON DELETE RESTRICT,
  nom VARCHAR(150) NOT NULL,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nullable : les poulaillers déjà en base n'ont pas encore de ferme.
-- À passer NOT NULL une fois les données reprises.
ALTER TABLE poulaillers
  ADD COLUMN IF NOT EXISTS ferme_id INT REFERENCES fermes(id) ON DELETE CASCADE;

-- ==========================================================
-- PERSONNEL — la paie, distincte des comptes.
-- Le responsable a une ligne ici ET un compte dans ouvriers ;
-- l'ouvrier simple n'a que cette ligne. Dans les deux cas c'est
-- le propriétaire qui fixe le salaire, lui seul le paie.
-- ==========================================================
CREATE TABLE IF NOT EXISTS personnel (
  id SERIAL PRIMARY KEY,
  ferme_id INT NOT NULL REFERENCES fermes(id) ON DELETE CASCADE,
  poulailler_id INT REFERENCES poulaillers(id) ON DELETE SET NULL,
  ouvrier_id INT REFERENCES ouvriers(id) ON DELETE SET NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('responsable', 'simple')),
  prenom VARCHAR(100) NOT NULL,
  telephone VARCHAR(20),
  -- NULL tant que le propriétaire ne l'a pas renseigné : le compte créé
  -- par SEDAP existe déjà, mais ne pèse pas encore sur les charges.
  salaire INT CHECK (salaire IS NULL OR salaire >= 0),
  prise_fonction DATE NOT NULL,
  fin_fonction DATE,
  CONSTRAINT responsable_a_un_compte CHECK (role <> 'responsable' OR ouvrier_id IS NOT NULL),
  CONSTRAINT simple_sans_compte      CHECK (role <> 'simple'      OR ouvrier_id IS NULL)
);

-- Un seul responsable en poste par poulailler.
CREATE UNIQUE INDEX IF NOT EXISTS un_responsable_par_poulailler
  ON personnel (poulailler_id)
  WHERE role = 'responsable' AND fin_fonction IS NULL;

-- ==========================================================
-- FRAIS — charges ponctuelles saisies par le propriétaire
-- ==========================================================
CREATE TABLE IF NOT EXISTS frais (
  id SERIAL PRIMARY KEY,
  ferme_id INT NOT NULL REFERENCES fermes(id) ON DELETE CASCADE,
  poulailler_id INT REFERENCES poulaillers(id) ON DELETE SET NULL,
  description VARCHAR(200) NOT NULL,
  montant INT NOT NULL CHECK (montant >= 0),
  -- Le frais se rattache au mois de CETTE date, pas au mois de la saisie.
  date_depense DATE NOT NULL,
  saisi_par INT NOT NULL REFERENCES proprietaires(id),
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ==========================================================
-- BANDES — la phase de vente
-- ==========================================================
ALTER TABLE bandes ADD COLUMN IF NOT EXISTS date_debut_vente TIMESTAMPTZ;

ALTER TABLE bandes DROP CONSTRAINT IF EXISTS bandes_statut_check;
ALTER TABLE bandes ADD CONSTRAINT bandes_statut_check
  CHECK (statut IN ('en_cours', 'en_vente', 'terminee'));

-- L'index ne visait que 'en_cours' : une bande en vente est active elle aussi.
DROP INDEX IF EXISTS une_seule_bande_active_par_poulailler;
CREATE UNIQUE INDEX une_seule_bande_active_par_poulailler
  ON bandes (poulailler_id)
  WHERE statut <> 'terminee';

-- ==========================================================
-- VENTES — auteur propriétaire et cohérence du prix
-- ==========================================================
-- Ces colonnes ont été ajoutées à schema.sql après coup. Sur une base créée
-- avant, CREATE TABLE IF NOT EXISTS n'a rien modifié : elles manquent encore.
ALTER TABLE ventes
  ADD COLUMN IF NOT EXISTS type_vente VARCHAR(20) NOT NULL DEFAULT 'ferme',
  ADD COLUMN IF NOT EXISTS auteur_type VARCHAR(20) NOT NULL DEFAULT 'ouvrier',
  ADD COLUMN IF NOT EXISTS auteur_ouvrier_id INT REFERENCES ouvriers(id),
  ADD COLUMN IF NOT EXISTS auteur_proprietaire_id INT REFERENCES proprietaires(id);

-- Un ramassage part sans prix : la colonne doit accepter NULL.
ALTER TABLE ventes ALTER COLUMN prix_unitaire DROP NOT NULL;

ALTER TABLE ventes DROP CONSTRAINT IF EXISTS ventes_type_vente_check;
ALTER TABLE ventes ADD CONSTRAINT ventes_type_vente_check
  CHECK (type_vente IN ('ferme', 'ramassage'));

ALTER TABLE ventes DROP CONSTRAINT IF EXISTS ventes_auteur_type_check;
ALTER TABLE ventes ADD CONSTRAINT ventes_auteur_type_check
  CHECK (auteur_type IN ('ouvrier', 'proprietaire'));

ALTER TABLE ventes DROP CONSTRAINT IF EXISTS vente_auteur_coherent;
-- NOT VALID : s'applique à toute nouvelle écriture, sans rejeter les lignes
-- déjà présentes qui n'ont pas d'auteur renseigné. Après reprise des données :
--   ALTER TABLE ventes VALIDATE CONSTRAINT vente_auteur_coherent;
ALTER TABLE ventes ADD CONSTRAINT vente_auteur_coherent CHECK (
  (auteur_type = 'ouvrier'      AND auteur_ouvrier_id IS NOT NULL AND auteur_proprietaire_id IS NULL) OR
  (auteur_type = 'proprietaire' AND auteur_proprietaire_id IS NOT NULL AND auteur_ouvrier_id IS NULL)
) NOT VALID;

-- Le prix ne peut manquer que sur un ramassage.
ALTER TABLE ventes DROP CONSTRAINT IF EXISTS vente_prix_selon_type;
ALTER TABLE ventes ADD CONSTRAINT vente_prix_selon_type CHECK (
  (type_vente = 'ferme'     AND prix_unitaire IS NOT NULL AND prix_unitaire >= 0) OR
  (type_vente = 'ramassage' AND prix_unitaire IS NULL)
) NOT VALID;

ALTER TABLE ventes DROP CONSTRAINT IF EXISTS vente_quantite_positive;
ALTER TABLE ventes ADD CONSTRAINT vente_quantite_positive CHECK (quantite > 0) NOT VALID;

-- ==========================================================
-- VENTES_DETAILS — éclatement d'un lot de ramassage.
-- N'ajoute aucun sujet : le lot les a déjà sortis du poulailler.
-- Ces lignes ne portent que de l'argent.
-- ==========================================================
CREATE TABLE IF NOT EXISTS ventes_details (
  id SERIAL PRIMARY KEY,
  vente_id INT NOT NULL REFERENCES ventes(id) ON DELETE CASCADE,
  nom_client VARCHAR(150) NOT NULL,
  telephone_client VARCHAR(20),
  quantite INT NOT NULL CHECK (quantite > 0),
  prix_unitaire NUMERIC(10,2) NOT NULL CHECK (prix_unitaire >= 0),
  saisi_par INT NOT NULL REFERENCES proprietaires(id),
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
