-- SEDAP'Tech — règles de vente et clôture, tenues par la base.
-- Trois interfaces écrivent dans ces tables. Placer ces contrôles dans
-- Express reviendrait à espérer que les trois clients les appliquent
-- de la même façon.

BEGIN;

-- Effectif présent au départ : les poussins morts à l'arrivée n'ont
-- jamais vécu dans le poulailler.
CREATE OR REPLACE FUNCTION effectif_initial(p_bande_id INT)
RETURNS INT LANGUAGE sql STABLE AS $$
  SELECT poussins_recus - morts_a_larrivee FROM bandes WHERE id = p_bande_id;
$$;

CREATE OR REPLACE FUNCTION sujets_morts(p_bande_id INT)
RETURNS INT LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(mortalite), 0)::INT
  FROM saisies_mortalite WHERE bande_id = p_bande_id;
$$;

-- Un lot de ramassage compte pour sa quantité entière ; ses lignes de
-- détail ne portent que de l'argent, jamais des sujets supplémentaires.
CREATE OR REPLACE FUNCTION sujets_vendus(p_bande_id INT)
RETURNS INT LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(quantite), 0)::INT
  FROM ventes WHERE bande_id = p_bande_id;
$$;

CREATE OR REPLACE FUNCTION effectif_restant(p_bande_id INT)
RETURNS INT LANGUAGE sql STABLE AS $$
  SELECT effectif_initial(p_bande_id)
       - sujets_morts(p_bande_id)
       - sujets_vendus(p_bande_id);
$$;

-- ---------------------------------------------------- ventes

CREATE OR REPLACE FUNCTION verifier_vente() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_statut VARCHAR(20);
  v_restant INT;
BEGIN
  SELECT statut INTO v_statut FROM bandes WHERE id = NEW.bande_id;

  IF v_statut <> 'en_vente' THEN
    RAISE EXCEPTION
      'Vente impossible : la bande % est au statut %, la vente n''est pas ouverte',
      NEW.bande_id, v_statut;
  END IF;

  -- Ouvrier et propriétaire puisent dans le même effectif.
  v_restant := effectif_restant(NEW.bande_id);

  IF NEW.quantite > v_restant THEN
    RAISE EXCEPTION
      'Vente de % sujets refusée : il n''en reste que %', NEW.quantite, v_restant;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vente_verifiee ON ventes;
CREATE TRIGGER vente_verifiee
  BEFORE INSERT ON ventes FOR EACH ROW EXECUTE FUNCTION verifier_vente();

-- ------------------------------------ éclatement d'un ramassage

CREATE OR REPLACE FUNCTION verifier_detail() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_type VARCHAR(20);
  v_lot INT;
  v_deja INT;
BEGIN
  SELECT type_vente, quantite INTO v_type, v_lot FROM ventes WHERE id = NEW.vente_id;

  IF v_type <> 'ramassage' THEN
    RAISE EXCEPTION
      'Seul un ramassage se détaille : la vente % est une vente à la ferme', NEW.vente_id;
  END IF;

  SELECT coalesce(sum(quantite), 0) INTO v_deja
  FROM ventes_details WHERE vente_id = NEW.vente_id AND id <> coalesce(NEW.id, 0);

  IF v_deja + NEW.quantite > v_lot THEN
    RAISE EXCEPTION
      'Détail refusé : le lot compte % sujets, % déjà attribués, % demandés',
      v_lot, v_deja, NEW.quantite;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS detail_verifie ON ventes_details;
CREATE TRIGGER detail_verifie
  BEFORE INSERT OR UPDATE ON ventes_details
  FOR EACH ROW EXECUTE FUNCTION verifier_detail();

-- --------------------------------------------- clôture automatique

-- La bande se ferme d'elle-même quand le poulailler est vide : pas de
-- second bouton, l'ouvrier n'a rien à cliquer de plus.
CREATE OR REPLACE FUNCTION cloturer_si_vide() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_bande_id INT := coalesce(NEW.bande_id, OLD.bande_id);
BEGIN
  IF effectif_restant(v_bande_id) <= 0 THEN
    UPDATE bandes SET statut = 'terminee', date_fin = now()
     WHERE id = v_bande_id AND statut = 'en_vente';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS bande_cloture ON ventes;
CREATE TRIGGER bande_cloture
  AFTER INSERT OR DELETE ON ventes
  FOR EACH ROW EXECUTE FUNCTION cloturer_si_vide();

-- ------------------------------------------------------- vues

CREATE OR REPLACE VIEW etat_bandes AS
SELECT
  b.id AS bande_id,
  b.poulailler_id,
  b.numero,
  b.statut,
  effectif_initial(b.id) AS effectif_initial,
  sujets_morts(b.id)     AS morts,
  sujets_vendus(b.id)    AS vendus,
  effectif_restant(b.id) AS restant,
  round(sujets_morts(b.id)::numeric * 100
        / nullif(effectif_initial(b.id), 0), 2) AS taux_mortalite
FROM bandes b;

-- Recettes : seules les quantités dont le prix est connu.
CREATE OR REPLACE VIEW recettes_bandes AS
SELECT
  b.id AS bande_id,
  coalesce((
    SELECT sum(v.quantite * v.prix_unitaire) FROM ventes v
    WHERE v.bande_id = b.id AND v.type_vente = 'ferme'
  ), 0)
  + coalesce((
    SELECT sum(d.quantite * d.prix_unitaire)
    FROM ventes_details d JOIN ventes v ON v.id = d.vente_id
    WHERE v.bande_id = b.id
  ), 0) AS recettes,
  coalesce((
    SELECT sum(v.quantite - coalesce((
      SELECT sum(d.quantite) FROM ventes_details d WHERE d.vente_id = v.id), 0))
    FROM ventes v WHERE v.bande_id = b.id AND v.type_vente = 'ramassage'
  ), 0) AS sujets_sans_prix
FROM bandes b;

COMMIT;
