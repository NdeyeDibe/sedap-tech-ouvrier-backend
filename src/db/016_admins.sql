-- Comptes administrateurs SEDAP — cahier admin v1.1, sections II, III et XI.5.
--
-- Table à part plutôt qu'un rôle ajouté à « ouvriers » ou « proprietaires » :
-- un admin n'a ni ferme, ni poulailler, ni PIN. Il se connecte par e-mail et
-- mot de passe, depuis un ordinateur ou une tablette.
--
-- Conséquence à garder en tête côté code : un admin et un ouvrier peuvent
-- porter le même identifiant, puisqu'ils vivent dans deux tables. Le rôle du
-- jeton fait seul la différence — d'où exigerRole() sur toutes les routes.
--
-- Pas de BEGIN/COMMIT ici : migrate.js joue déjà chaque fichier dans sa
-- propre transaction.

CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  email VARCHAR(150) NOT NULL,
  -- NULL tant que l'admin n'a pas choisi son mot de passe : « + Ajouter un
  -- admin » n'envoie qu'un lien à usage unique (24 h), jamais un mot de passe
  -- en clair (XI.5).
  mot_de_passe_hash VARCHAR(255),
  prenom VARCHAR(100),
  nom VARCHAR(100),
  role VARCHAR(20) NOT NULL DEFAULT 'admin'
    CHECK (role IN ('admin', 'admin_principal')),
  actif BOOLEAN NOT NULL DEFAULT TRUE,

  -- Connexion bloquée 15 minutes après 5 échecs consécutifs (III).
  -- Un blocage daté plutôt qu'un booléen : il se lève tout seul, sans
  -- intervention de personne.
  tentatives_echouees INT NOT NULL DEFAULT 0,
  bloque_jusqua TIMESTAMPTZ,

  -- Sert aux deux usages : premier mot de passe (24 h) et mot de passe
  -- oublié (1 h). Effacé dès qu'il a servi.
  jeton_reinitialisation TEXT,
  jeton_expire_le TIMESTAMPTZ,

  derniere_connexion TIMESTAMPTZ,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  cree_par INT REFERENCES admins(id) ON DELETE SET NULL
);

-- Unicité insensible à la casse : « Mengue@sedap.sn » et « mengue@sedap.sn »
-- sont la même personne, et la connexion cherche déjà en minuscules.
CREATE UNIQUE INDEX IF NOT EXISTS admins_email_unique
  ON admins (lower(email));

-- Le jeton est le secret du lien : il doit désigner un seul compte.
CREATE UNIQUE INDEX IF NOT EXISTS admins_jeton_unique
  ON admins (jeton_reinitialisation)
  WHERE jeton_reinitialisation IS NOT NULL;

-- Journal des actions d'administration — qui a fait quoi, sur qui, quand.
-- Les suspensions, corrections de saisie et modifications de seuils auront
-- leurs propres tables (migrations suivantes) ; celle-ci reçoit le reste :
-- création de compte, renvoi de lien, déverrouillage, réinitialisation de PIN.
CREATE TABLE IF NOT EXISTS admin_journal (
  id SERIAL PRIMARY KEY,
  admin_id INT REFERENCES admins(id) ON DELETE SET NULL,
  action VARCHAR(60) NOT NULL,
  cible_type VARCHAR(30),        -- 'proprietaire' | 'ouvrier' | 'poulailler' | 'admin' | 'ferme'
  cible_id INT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_journal_cible
  ON admin_journal (cible_type, cible_id, cree_le DESC);
