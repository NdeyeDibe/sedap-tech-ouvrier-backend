-- Rattrapage des colonnes manquantes.
--
-- schema.sql s'est enrichi au fil du projet, mais CREATE TABLE IF NOT EXISTS
-- ne modifie jamais une table déjà créée : toute colonne ajoutée après la
-- première migration n'a jamais atteint les bases existantes. Les erreurs
-- « column ... does not exist » sur produits_utilises, ventes et
-- saisies_mortalite venaient toutes de là.
--
-- Ce fichier réaligne d'un coup toute base sur le schéma courant. Sur une base
-- déjà à jour, il ne fait rien. Une table absente est ignorée plutôt que de
-- faire échouer l'ensemble.
--
-- Deux libertés prises, faute de pouvoir faire autrement sur une table déjà
-- peuplée : les NOT NULL sans valeur par défaut et les UNIQUE en ligne sont
-- omis. À rétablir après reprise des données si besoin.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.ouvriers') IS NOT NULL THEN
      ALTER TABLE ouvriers ADD COLUMN IF NOT EXISTS telephone VARCHAR(20);
      ALTER TABLE ouvriers ADD COLUMN IF NOT EXISTS pin_hash VARCHAR(255);
      ALTER TABLE ouvriers ADD COLUMN IF NOT EXISTS nom VARCHAR(100);
      ALTER TABLE ouvriers ADD COLUMN IF NOT EXISTS prenom VARCHAR(100);
      ALTER TABLE ouvriers ADD COLUMN IF NOT EXISTS tentatives_echouees INT NOT NULL DEFAULT 0;
      ALTER TABLE ouvriers ADD COLUMN IF NOT EXISTS compte_verrouille BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE ouvriers ADD COLUMN IF NOT EXISTS cree_le TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.credentials_webauthn') IS NOT NULL THEN
      ALTER TABLE credentials_webauthn ADD COLUMN IF NOT EXISTS ouvrier_id INT REFERENCES ouvriers(id) ON DELETE CASCADE;
      ALTER TABLE credentials_webauthn ADD COLUMN IF NOT EXISTS identifiant_credential TEXT;
      ALTER TABLE credentials_webauthn ADD COLUMN IF NOT EXISTS cle_publique TEXT;
      ALTER TABLE credentials_webauthn ADD COLUMN IF NOT EXISTS compteur BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE credentials_webauthn ADD COLUMN IF NOT EXISTS cree_le TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.poulaillers') IS NOT NULL THEN
      ALTER TABLE poulaillers ADD COLUMN IF NOT EXISTS ouvrier_id INT REFERENCES ouvriers(id) ON DELETE CASCADE;
      ALTER TABLE poulaillers ADD COLUMN IF NOT EXISTS nom VARCHAR(100);
      ALTER TABLE poulaillers ADD COLUMN IF NOT EXISTS cree_le TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.bandes') IS NOT NULL THEN
      ALTER TABLE bandes ADD COLUMN IF NOT EXISTS poulailler_id INT REFERENCES poulaillers(id) ON DELETE CASCADE;
      ALTER TABLE bandes ADD COLUMN IF NOT EXISTS numero INT;
      ALTER TABLE bandes ADD COLUMN IF NOT EXISTS statut VARCHAR(20) NOT NULL DEFAULT 'en_cours' CHECK (statut IN ('en_cours', 'terminee'));
      ALTER TABLE bandes ADD COLUMN IF NOT EXISTS poussins_commandes INT;
      ALTER TABLE bandes ADD COLUMN IF NOT EXISTS poussins_recus INT;
      ALTER TABLE bandes ADD COLUMN IF NOT EXISTS morts_a_larrivee INT NOT NULL DEFAULT 0;
      ALTER TABLE bandes ADD COLUMN IF NOT EXISTS provenance VARCHAR(100);
      ALTER TABLE bandes ADD COLUMN IF NOT EXISTS souche VARCHAR(100);
      ALTER TABLE bandes ADD COLUMN IF NOT EXISTS poids_reception_g INT;
      ALTER TABLE bandes ADD COLUMN IF NOT EXISTS date_debut TIMESTAMPTZ NOT NULL DEFAULT now();
      ALTER TABLE bandes ADD COLUMN IF NOT EXISTS date_fin TIMESTAMPTZ;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.saisies_mortalite') IS NOT NULL THEN
      ALTER TABLE saisies_mortalite ADD COLUMN IF NOT EXISTS bande_id INT REFERENCES bandes(id) ON DELETE CASCADE;
      ALTER TABLE saisies_mortalite ADD COLUMN IF NOT EXISTS date_saisie DATE NOT NULL DEFAULT CURRENT_DATE;
      ALTER TABLE saisies_mortalite ADD COLUMN IF NOT EXISTS mortalite INT NOT NULL DEFAULT 0;
      ALTER TABLE saisies_mortalite ADD COLUMN IF NOT EXISTS photos TEXT[] NOT NULL DEFAULT '{}';
      ALTER TABLE saisies_mortalite ADD COLUMN IF NOT EXISTS cree_le TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.saisies_sante') IS NOT NULL THEN
      ALTER TABLE saisies_sante ADD COLUMN IF NOT EXISTS bande_id INT REFERENCES bandes(id) ON DELETE CASCADE;
      ALTER TABLE saisies_sante ADD COLUMN IF NOT EXISTS date_saisie DATE NOT NULL DEFAULT CURRENT_DATE;
      ALTER TABLE saisies_sante ADD COLUMN IF NOT EXISTS etat VARCHAR(20) CHECK (etat IN ('bien', 'anormal', 'urgent'));
      ALTER TABLE saisies_sante ADD COLUMN IF NOT EXISTS a_vocal BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE saisies_sante ADD COLUMN IF NOT EXISTS photos TEXT[] NOT NULL DEFAULT '{}';
      ALTER TABLE saisies_sante ADD COLUMN IF NOT EXISTS cree_le TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.saisies_alimentation') IS NOT NULL THEN
      ALTER TABLE saisies_alimentation ADD COLUMN IF NOT EXISTS bande_id INT REFERENCES bandes(id) ON DELETE CASCADE;
      ALTER TABLE saisies_alimentation ADD COLUMN IF NOT EXISTS date_saisie DATE NOT NULL DEFAULT CURRENT_DATE;
      ALTER TABLE saisies_alimentation ADD COLUMN IF NOT EXISTS type_aliment VARCHAR(30) CHECK (type_aliment IN ('demarrage', 'croissance', 'finition'));
      ALTER TABLE saisies_alimentation ADD COLUMN IF NOT EXISTS sacs NUMERIC(6,2) NOT NULL DEFAULT 0;
      ALTER TABLE saisies_alimentation ADD COLUMN IF NOT EXISTS kg_supplementaires NUMERIC(6,2) NOT NULL DEFAULT 0;
      ALTER TABLE saisies_alimentation ADD COLUMN IF NOT EXISTS cree_le TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.vaccinations') IS NOT NULL THEN
      ALTER TABLE vaccinations ADD COLUMN IF NOT EXISTS bande_id INT REFERENCES bandes(id) ON DELETE CASCADE;
      ALTER TABLE vaccinations ADD COLUMN IF NOT EXISTS jour_bande INT;
      ALTER TABLE vaccinations ADD COLUMN IF NOT EXISTS vaccin_nom VARCHAR(100);
      ALTER TABLE vaccinations ADD COLUMN IF NOT EXISTS date_saisie DATE NOT NULL DEFAULT CURRENT_DATE;
      ALTER TABLE vaccinations ADD COLUMN IF NOT EXISTS cree_le TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.pesages') IS NOT NULL THEN
      ALTER TABLE pesages ADD COLUMN IF NOT EXISTS bande_id INT REFERENCES bandes(id) ON DELETE CASCADE;
      ALTER TABLE pesages ADD COLUMN IF NOT EXISTS jour_bande INT;
      ALTER TABLE pesages ADD COLUMN IF NOT EXISTS poids_g INT;
      ALTER TABLE pesages ADD COLUMN IF NOT EXISTS dans_fourchette BOOLEAN;
      ALTER TABLE pesages ADD COLUMN IF NOT EXISTS date_saisie DATE NOT NULL DEFAULT CURRENT_DATE;
      ALTER TABLE pesages ADD COLUMN IF NOT EXISTS cree_le TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.stock_produits') IS NOT NULL THEN
      ALTER TABLE stock_produits ADD COLUMN IF NOT EXISTS poulailler_id INT REFERENCES poulaillers(id) ON DELETE CASCADE;
      ALTER TABLE stock_produits ADD COLUMN IF NOT EXISTS produit_id VARCHAR(30);
      ALTER TABLE stock_produits ADD COLUMN IF NOT EXISTS variante_id VARCHAR(50);
      ALTER TABLE stock_produits ADD COLUMN IF NOT EXISTS nom VARCHAR(100);
      ALTER TABLE stock_produits ADD COLUMN IF NOT EXISTS unite VARCHAR(20);
      ALTER TABLE stock_produits ADD COLUMN IF NOT EXISTS quantite NUMERIC(10,2) NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.stock_receptions') IS NOT NULL THEN
      ALTER TABLE stock_receptions ADD COLUMN IF NOT EXISTS stock_produit_id INT REFERENCES stock_produits(id) ON DELETE CASCADE;
      ALTER TABLE stock_receptions ADD COLUMN IF NOT EXISTS quantite_recue NUMERIC(10,2);
      ALTER TABLE stock_receptions ADD COLUMN IF NOT EXISTS prix_unitaire NUMERIC(10,2);
      ALTER TABLE stock_receptions ADD COLUMN IF NOT EXISTS provenance VARCHAR(100);
      ALTER TABLE stock_receptions ADD COLUMN IF NOT EXISTS date_reception TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.stock_autres_produits') IS NOT NULL THEN
      ALTER TABLE stock_autres_produits ADD COLUMN IF NOT EXISTS poulailler_id INT REFERENCES poulaillers(id) ON DELETE CASCADE;
      ALTER TABLE stock_autres_produits ADD COLUMN IF NOT EXISTS nom VARCHAR(150);
      ALTER TABLE stock_autres_produits ADD COLUMN IF NOT EXISTS quantite NUMERIC(10,2);
      ALTER TABLE stock_autres_produits ADD COLUMN IF NOT EXISTS prix_unitaire NUMERIC(10,2);
      ALTER TABLE stock_autres_produits ADD COLUMN IF NOT EXISTS date_reception TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.produits_utilises') IS NOT NULL THEN
      ALTER TABLE produits_utilises ADD COLUMN IF NOT EXISTS bande_id INT REFERENCES bandes(id) ON DELETE CASCADE;
      ALTER TABLE produits_utilises ADD COLUMN IF NOT EXISTS stock_produit_id INT REFERENCES stock_produits(id);
      ALTER TABLE produits_utilises ADD COLUMN IF NOT EXISTS stock_autre_produit_id INT REFERENCES stock_autres_produits(id);
      ALTER TABLE produits_utilises ADD COLUMN IF NOT EXISTS quantite NUMERIC(10,2);
      ALTER TABLE produits_utilises ADD COLUMN IF NOT EXISTS date_saisie DATE NOT NULL DEFAULT CURRENT_DATE;
      ALTER TABLE produits_utilises ADD COLUMN IF NOT EXISTS cree_le TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.ventes') IS NOT NULL THEN
      ALTER TABLE ventes ADD COLUMN IF NOT EXISTS bande_id INT REFERENCES bandes(id) ON DELETE CASCADE;
      ALTER TABLE ventes ADD COLUMN IF NOT EXISTS type_vente VARCHAR(20) NOT NULL DEFAULT 'ferme' CHECK (type_vente IN ('ferme', 'ramassage'));
      ALTER TABLE ventes ADD COLUMN IF NOT EXISTS nom_client VARCHAR(150);
      ALTER TABLE ventes ADD COLUMN IF NOT EXISTS telephone_client VARCHAR(20);
      ALTER TABLE ventes ADD COLUMN IF NOT EXISTS prix_unitaire NUMERIC(10,2);
      ALTER TABLE ventes ADD COLUMN IF NOT EXISTS quantite INT;
      ALTER TABLE ventes ADD COLUMN IF NOT EXISTS date_vente TIMESTAMPTZ NOT NULL DEFAULT now();
      ALTER TABLE ventes ADD COLUMN IF NOT EXISTS auteur_type VARCHAR(20) NOT NULL DEFAULT 'ouvrier' CHECK (auteur_type IN ('ouvrier', 'proprietaire'));
      ALTER TABLE ventes ADD COLUMN IF NOT EXISTS auteur_ouvrier_id INT REFERENCES ouvriers(id);
  END IF;
END $$;

COMMIT;
