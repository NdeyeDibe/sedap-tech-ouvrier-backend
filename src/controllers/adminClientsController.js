const crypto = require("crypto");
const pool = require("../db/pool");
const { parAdmin } = require("../services/journal");
const { creerStockInitial } = require("../utils/stockInitial");

// Clients — cahier admin, section VII.
//
// Un propriétaire ne s'inscrit jamais seul : c'est SEDAP qui crée son
// compte, sa ferme et ses poulaillers, puis lui transmet un lien
// d'activation. Il confirme son identité, choisit son code PIN, et le
// compte devient actif.
//
// Le lien est à usage unique et vaut 7 jours (cahier VII). Tant que le PIN
// n'est pas créé, le compte reste « en attente d'activation ».

const JOURS_VALIDITE_LIEN = 7;

// Adresse de l'appli propriétaire, pour composer le lien d'activation.
const URL_PROPRIETAIRE = process.env.PROPRIETAIRE_URL || null;

// L'état du compte, même vocabulaire que la fiche d'une ferme.
function etatCompte(p) {
  // La suspension prime : c'est une décision de SEDAP, pas un incident.
  if (p.suspendu_le) return "suspendu";
  if (p.compte_verrouille) return "verrouille";
  if (!p.pin_hash) return "en_attente";
  return "actif";
}

const REQUETE_CLIENTS = `
  SELECT p.id, p.prenom, p.nom, p.telephone, p.email, p.cree_le,
         p.pin_hash, p.compte_verrouille, p.suspendu_le,
         f.id AS ferme_id, f.nom AS ferme_nom, f.localite,
         (SELECT count(*) FROM poulaillers pl
           WHERE pl.ferme_id = f.id AND pl.archive_le IS NULL) AS poulaillers,
         (SELECT count(*) FROM bandes b
            JOIN poulaillers pl ON pl.id = b.poulailler_id
           WHERE pl.ferme_id = f.id AND b.statut <> 'terminee') AS bandes_actives,
         (SELECT count(*) FROM bandes b
            JOIN poulaillers pl ON pl.id = b.poulailler_id
           WHERE pl.ferme_id = f.id AND b.statut = 'terminee') AS bandes_terminees
    FROM proprietaires p
    LEFT JOIN fermes f ON f.proprietaire_id = p.id
   ORDER BY p.prenom, p.nom
`;

// GET /api/admin/clients?recherche=…&compte=…
//
// La recherche porte sur le nom, le téléphone et l'e-mail : c'est par l'un
// des trois que SEDAP retrouve quelqu'un au téléphone.
async function listeClients(req, res) {
  const recherche = String(req.query.recherche ?? "").trim();
  const compte = String(req.query.compte ?? "").trim();

  try {
    const { rows } = await pool.query(REQUETE_CLIENTS);

    const tous = rows.map((p) => ({
      id: p.id,
      prenom: p.prenom,
      nom: p.nom,
      telephone: p.telephone,
      email: p.email,
      clientDepuis: p.cree_le,
      compte: etatCompte(p),
      ferme: p.ferme_id
        ? {
            id: p.ferme_id,
            nom: p.ferme_nom,
            localite: p.localite,
            poulaillers: Number(p.poulaillers),
          }
        : null,
      bandes: {
        actives: Number(p.bandes_actives ?? 0),
        terminees: Number(p.bandes_terminees ?? 0),
      },
    }));

    // La recherche s'applique d'abord. Les compteurs des pastilles portent
    // sur elle, pas sur la base entière : « Actifs · 9 » doit dire combien
    // de lignes s'afficheront si on clique, sinon le chiffre ment.
    const trouves = tous.filter((c) => correspond(c, recherche));

    const compteurs = { tous: trouves.length, actif: 0, en_attente: 0, verrouille: 0, suspendu: 0 };
    for (const c of trouves) compteurs[c.compte] = (compteurs[c.compte] ?? 0) + 1;

    res.json({
      clients: compte ? trouves.filter((c) => c.compte === compte) : trouves,
      compteurs,
      // Le total sans aucun filtre, pour le sous-titre de l'écran.
      total: tous.length,
    });
  } catch (erreur) {
    console.error("Erreur liste des clients :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// Le filtrage se fait ici plutôt qu'en SQL : la clientèle de SEDAP se
// compte en dizaines, et le code reste lisible.
const sansAccents = (t) =>
  String(t ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const chiffresSeuls = (t) => String(t ?? "").replace(/\D/g, "");

// Nom, téléphone, e-mail ou ferme : au téléphone, SEDAP retrouve quelqu'un
// par l'un des quatre, et rarement par celui auquel on aurait pensé.
function correspond(c, recherche) {
  if (!recherche) return true;
  const aiguille = sansAccents(recherche);
  const nombres = chiffresSeuls(recherche);
  return (
    sansAccents(`${c.prenom} ${c.nom}`).includes(aiguille) ||
    sansAccents(c.email).includes(aiguille) ||
    sansAccents(c.ferme?.nom).includes(aiguille) ||
    (nombres.length >= 3 && chiffresSeuls(c.telephone).includes(nombres))
  );
}

// Un numéro international : on garde les chiffres et on impose un « + ».
// Les propriétaires vivent parfois à l'étranger (cahier VII), on ne peut
// donc pas appliquer la règle sénégalaise des 9 chiffres.
function telephoneInternational(valeur) {
  const brut = String(valeur ?? "").trim();
  const chiffres = brut.replace(/\D/g, "");
  if (chiffres.length < 8 || chiffres.length > 15) return null;
  return `+${chiffres}`;
}

const texte = (v) => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};

// POST /api/admin/clients
//
// Un seul formulaire crée le propriétaire, sa ferme et ses poulaillers :
// séparer les trois obligerait SEDAP à enchaîner trois écrans pour un
// client qui vient de signer, et laisserait des comptes sans ferme.
async function creerClient(req, res) {
  const prenom = texte(req.body.prenom);
  const nom = texte(req.body.nom);
  const telephone = telephoneInternational(req.body.telephone);
  const email = texte(req.body.email)?.toLowerCase() ?? null;
  const fermeNom = texte(req.body.ferme?.nom);
  const localite = texte(req.body.ferme?.localite);
  const poulaillers = Array.isArray(req.body.poulaillers) ? req.body.poulaillers : [];

  if (!prenom || !nom) return res.status(400).json({ erreur: "Prénom et nom requis." });
  if (!telephone) {
    return res.status(400).json({
      erreur: "Téléphone invalide : indicatif pays et numéro attendus (ex. +221 77 123 45 67).",
    });
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ erreur: "E-mail invalide." });
  }
  if (!fermeNom || !localite) {
    return res.status(400).json({ erreur: "Nom et localité de la ferme requis." });
  }
  if (poulaillers.length === 0) {
    return res.status(400).json({ erreur: "Au moins un poulailler est attendu." });
  }

  const lignes = poulaillers.map((p, i) => ({
    nom: texte(p?.nom) ?? `Poulailler ${i + 1}`,
    capacite: p?.capacite === null || p?.capacite === undefined || p?.capacite === ""
      ? null
      : Number(p.capacite),
  }));
  for (const l of lignes) {
    if (l.capacite !== null && (!Number.isInteger(l.capacite) || l.capacite <= 0)) {
      return res.status(400).json({
        erreur: `Capacité invalide pour ${l.nom} : un nombre de sujets supérieur à 0 est attendu.`,
      });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const jeton = crypto.randomBytes(32).toString("base64url");

    const { rows: crees } = await client.query(
      `INSERT INTO proprietaires (prenom, nom, telephone, email, jeton_activation, jeton_expire_le)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)
       RETURNING id, prenom, nom, telephone, email, jeton_expire_le`,
      [prenom, nom, telephone, email, jeton, String(JOURS_VALIDITE_LIEN)]
    );
    const proprietaire = crees[0];

    const { rows: fermes } = await client.query(
      "INSERT INTO fermes (proprietaire_id, nom, localite) VALUES ($1, $2, $3) RETURNING id, nom",
      [proprietaire.id, fermeNom, localite]
    );
    const ferme = fermes[0];

    const poulaillersCrees = [];
    for (const l of lignes) {
      const { rows } = await client.query(
        "INSERT INTO poulaillers (ferme_id, nom, capacite) VALUES ($1, $2, $3) RETURNING id, nom, capacite",
        [ferme.id, l.nom, l.capacite]
      );
      // Chaque poulailler neuf reçoit son catalogue de stock, sinon
      // l'ouvrier ne pourrait rien déclarer à sa première réception.
      await creerStockInitial(client, rows[0].id);
      poulaillersCrees.push(rows[0]);
    }

    await client.query("COMMIT");

    parAdmin(req, {
      action: "proprietaire_cree",
      cibleType: "proprietaire",
      cibleId: proprietaire.id,
      proprietaireId: proprietaire.id,
      fermeId: ferme.id,
      details: {
        prenom,
        nom,
        telephone,
        email,
        ferme: fermeNom,
        localite,
        poulaillers: poulaillersCrees.length,
      },
    });

    res.status(201).json({
      proprietaire: {
        id: proprietaire.id,
        prenom: proprietaire.prenom,
        nom: proprietaire.nom,
        telephone: proprietaire.telephone,
        email: proprietaire.email,
        compte: "en_attente",
      },
      ferme: { id: ferme.id, nom: ferme.nom },
      poulaillers: poulaillersCrees,
      activation: lienActivation(jeton, proprietaire),
    });
  } catch (erreur) {
    await client.query("ROLLBACK");
    if (erreur.code === "23505") {
      const champ = String(erreur.detail || "").includes("email") ? "Cet e-mail" : "Ce numéro";
      return res.status(409).json({ erreur: `${champ} est déjà utilisé par un autre compte.` });
    }
    console.error("Erreur création client :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

// Le lien et le message prêt à transmettre. Pas encore de service d'envoi :
// l'écran les affiche avec un bouton « Copier » (cahier VII).
// « nouveau » = le compte vient d'être créé ; « pin » = le propriétaire a
// oublié son code. Écrire « votre espace est prêt » à quelqu'un qui utilise
// l'appli depuis six mois lui ferait croire à une erreur.
function lienActivation(jeton, proprietaire, raison = "nouveau") {
  const lien = URL_PROPRIETAIRE
    ? `${URL_PROPRIETAIRE.replace(/\/$/, "")}/activation?jeton=${jeton}`
    : null;

  const ouvrez = lien ? `Ouvrez ${lien} ` : "Ouvrez l'application SEDAP'Tech ";

  const message =
    raison === "pin"
      ? `Bonjour ${proprietaire.prenom}, votre code SEDAP'Tech a été réinitialisé à votre demande. ` +
        ouvrez +
        `pour en choisir un nouveau. Ce lien est valable 7 jours.`
      : `Bonjour ${proprietaire.prenom}, votre espace SEDAP'Tech est prêt. ` +
        ouvrez +
        `pour confirmer votre numéro et choisir votre code à 4 chiffres. ` +
        `Ce lien est valable 7 jours.`;

  return { jeton, lien, message, expireLe: proprietaire.jeton_expire_le };
}


// ------------------------------------------------ fiche d'un propriétaire

// Ce que raconte l'historique du compte. Le journal contient bien d'autres
// actions ; ici on ne garde que celles qui concernent le compte lui-même.
const ACTIONS_COMPTE = [
  "proprietaire_cree",
  "compte_active",
  "compte_verrouille",
  "compte_deverrouille",
  "compte_suspendu",
  "compte_reactive",
  "pin_reinitialise",
  "lien_renvoye",
  "proprietaire_modifie",
];

const RECIT = {
  proprietaire_cree: (d, par) => `Compte créé${par ? ` par ${par}` : ""}`,
  compte_active: () => "Compte activé, PIN créé",
  compte_verrouille: (d) => `Compte verrouillé${d?.motif ? ` après ${d.motif}` : ""}`,
  compte_deverrouille: (d, par) => `Compte déverrouillé${par ? ` par ${par}` : ""}`,
  compte_suspendu: (d, par) => `Compte suspendu${par ? ` par ${par}` : ""}${d?.motif ? ` — ${d.motif}` : ""}`,
  compte_reactive: (d, par) => `Compte réactivé${par ? ` par ${par}` : ""}`,
  pin_reinitialise: (d, par) => `Code PIN réinitialisé${par ? ` par ${par}` : ""}`,
  lien_renvoye: (d, par) => `Lien d'activation renvoyé${par ? ` par ${par}` : ""}`,
  proprietaire_modifie: (d, par) => `Fiche modifiée${par ? ` par ${par}` : ""}`,
};

// GET /api/admin/clients/:id — maquette 12.
async function ficheClient(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ erreur: "Identifiant invalide." });
  }

  try {
    const { rows } = await pool.query(
      `SELECT p.*, f.id AS ferme_id, f.nom AS ferme_nom, f.localite
         FROM proprietaires p
         LEFT JOIN fermes f ON f.proprietaire_id = p.id
        WHERE p.id = $1`,
      [id]
    );
    const p = rows[0];
    if (!p) return res.status(404).json({ erreur: "Propriétaire introuvable." });

    const [poulaillers, historique, suspendPar] = await Promise.all([
      // Un ouvrier responsable par poulailler, avec la bande en cours :
      // c'est la colonne de droite de la maquette.
      pool.query(
        `SELECT pl.id, pl.nom, pl.capacite,
                o.id AS ouvrier_id, o.prenom, o.nom AS ouvrier_nom, o.telephone,
                (o.pin_hash IS NOT NULL) AS pin_cree,
                o.compte_verrouille,
                b.id AS bande_id, b.numero AS bande_numero,
                (now()::date - b.date_debut::date)::int + 1 AS bande_jour
           FROM poulaillers pl
           LEFT JOIN personnel pe
             ON pe.poulailler_id = pl.id AND pe.role = 'responsable' AND pe.fin_fonction IS NULL
           LEFT JOIN ouvriers o ON o.id = pe.ouvrier_id
           LEFT JOIN bandes b ON b.poulailler_id = pl.id AND b.statut <> 'terminee'
          WHERE pl.ferme_id = $1 AND pl.archive_le IS NULL
          ORDER BY pl.id`,
        [p.ferme_id]
      ),
      pool.query(
        `SELECT j.cree_le, j.action, j.details,
                a.prenom AS admin_prenom, a.nom AS admin_nom
           FROM journal_activite j
           LEFT JOIN admins a ON a.id = j.acteur_id AND j.acteur_type = 'admin'
          WHERE j.proprietaire_id = $1 AND j.action = ANY($2)
          ORDER BY j.cree_le DESC
          LIMIT 30`,
        [id, ACTIONS_COMPTE]
      ),
      p.suspendu_par
        ? pool.query("SELECT prenom, nom FROM admins WHERE id = $1", [p.suspendu_par])
        : Promise.resolve({ rows: [] }),
    ]);

    res.json({
      proprietaire: {
        id: p.id,
        prenom: p.prenom,
        nom: p.nom,
        telephone: p.telephone,
        email: p.email,
        clientDepuis: p.cree_le,
        compte: etatCompte(p),
        activeeLe: p.activee_le,
        derniereConnexion: p.derniere_connexion,
      },
      ferme: p.ferme_id
        ? {
            id: p.ferme_id,
            nom: p.ferme_nom,
            localite: p.localite,
            poulaillers: poulaillers.rows.length,
          }
        : null,
      securite: {
        pinCree: !!p.pin_hash,
        // Le PIN n'a pas de date propre : c'est l'activation qui le crée.
        pinCreeLe: p.activee_le,
        essaisFaux: p.tentatives_echouees,
        essaisMax: 3,
        verrouille: p.compte_verrouille,
        // Même règle que l'appli : la session dure, le PIN est redemandé
        // à chaque réouverture.
        session: "30 jours, puis PIN seul",
      },
      suspension: p.suspendu_le
        ? {
            le: p.suspendu_le,
            motif: p.suspendu_motif,
            par: suspendPar.rows[0]
              ? [suspendPar.rows[0].prenom, suspendPar.rows[0].nom].filter(Boolean).join(" ")
              : null,
          }
        : null,
      activation: p.jeton_activation
        ? { enAttente: true, expireLe: p.jeton_expire_le }
        : { enAttente: false, expireLe: null },
      poulaillers: poulaillers.rows.map((pl) => ({
        id: pl.id,
        nom: pl.nom,
        capacite: pl.capacite,
        bande: pl.bande_id
          ? { id: pl.bande_id, numero: pl.bande_numero, jour: Number(pl.bande_jour) }
          : null,
        responsable: pl.ouvrier_id
          ? {
              id: pl.ouvrier_id,
              prenom: pl.prenom,
              nom: pl.ouvrier_nom,
              telephone: pl.telephone,
              pinCree: pl.pin_cree,
              verrouille: pl.compte_verrouille,
            }
          : null,
      })),
      historique: historique.rows.map((h) => {
        const par = [h.admin_prenom, h.admin_nom].filter(Boolean).join(" ");
        const recit = RECIT[h.action];
        return {
          date: h.cree_le,
          texte: recit ? recit(h.details, par) : h.action,
        };
      }),
    });
  } catch (erreur) {
    console.error("Erreur fiche client :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}


// ------------------------------------------------------------- actions

// PATCH /api/admin/clients/:id — modifier la fiche (cahier VII).
//
// Changer le téléphone ou l'e-mail change l'identifiant de connexion.
// Le cahier ne demande pas de code de confirmation : l'admin a vérifié
// l'identité de son côté. Mais la modification est journalisée.
async function modifierClient(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erreur: "Identifiant invalide." });

  const prenom = texte(req.body.prenom);
  const nom = texte(req.body.nom);
  const telephone = req.body.telephone === undefined ? undefined : telephoneInternational(req.body.telephone);
  const email = req.body.email === undefined ? undefined : texte(req.body.email)?.toLowerCase() ?? null;
  const fermeNom = texte(req.body.ferme?.nom);
  const localite = texte(req.body.ferme?.localite);

  if (!prenom || !nom) return res.status(400).json({ erreur: "Prénom et nom requis." });
  if (telephone === null) {
    return res.status(400).json({ erreur: "Téléphone invalide : indicatif pays et numéro attendus." });
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ erreur: "E-mail invalide." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: avant } = await client.query(
      `SELECT p.prenom, p.nom, p.telephone, p.email, f.id AS ferme_id, f.nom AS ferme_nom, f.localite
         FROM proprietaires p LEFT JOIN fermes f ON f.proprietaire_id = p.id
        WHERE p.id = $1 FOR UPDATE OF p`,
      [id]
    );
    if (!avant[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erreur: "Propriétaire introuvable." });
    }

    await client.query(
      `UPDATE proprietaires
          SET prenom = $2, nom = $3,
              telephone = coalesce($4, telephone),
              email = CASE WHEN $5::boolean THEN $6 ELSE email END
        WHERE id = $1`,
      [id, prenom, nom, telephone ?? null, email !== undefined, email ?? null]
    );

    if (avant[0].ferme_id && (fermeNom || localite)) {
      await client.query(
        "UPDATE fermes SET nom = coalesce($2, nom), localite = coalesce($3, localite) WHERE id = $1",
        [avant[0].ferme_id, fermeNom, localite]
      );
    }

    await client.query("COMMIT");

    parAdmin(req, {
      action: "proprietaire_modifie",
      cibleType: "proprietaire",
      cibleId: id,
      proprietaireId: id,
      details: {
        avant: {
          prenom: avant[0].prenom,
          nom: avant[0].nom,
          telephone: avant[0].telephone,
          email: avant[0].email,
          ferme: avant[0].ferme_nom,
          localite: avant[0].localite,
        },
      },
    });

    res.json({ id, modifie: true });
  } catch (erreur) {
    await client.query("ROLLBACK");
    if (erreur.code === "23505") {
      const champ = String(erreur.detail || "").includes("email") ? "Cet e-mail" : "Ce numéro";
      return res.status(409).json({ erreur: `${champ} est déjà utilisé par un autre compte.` });
    }
    console.error("Erreur modification client :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

// PATCH /api/admin/clients/:id/suspendre — maquette 13.
async function suspendreClient(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erreur: "Identifiant invalide." });

  const motif = texte(req.body.motif);
  if (!motif) {
    // Une suspension sans motif est inexploitable : ni le client à qui on
    // l'explique, ni l'admin qui la lève six mois plus tard ne sauront.
    return res.status(400).json({ erreur: "Indiquez le motif de la suspension." });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE proprietaires
          SET suspendu_le = now(), suspendu_motif = $2, suspendu_par = $3
        WHERE id = $1 AND suspendu_le IS NULL
        RETURNING id, prenom, nom`,
      [id, motif, req.utilisateur.id]
    );

    if (!rows[0]) {
      const { rows: existe } = await pool.query("SELECT suspendu_le FROM proprietaires WHERE id = $1", [id]);
      if (!existe[0]) return res.status(404).json({ erreur: "Propriétaire introuvable." });
      return res.status(409).json({ erreur: "Ce compte est déjà suspendu." });
    }

    parAdmin(req, {
      action: "compte_suspendu",
      cibleType: "proprietaire",
      cibleId: id,
      proprietaireId: id,
      details: { motif },
    });

    res.json({ id, suspendu: true });
  } catch (erreur) {
    console.error("Erreur suspension :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// PATCH /api/admin/clients/:id/reactiver
async function reactiverClient(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erreur: "Identifiant invalide." });

  try {
    const { rows } = await pool.query(
      `UPDATE proprietaires
          SET suspendu_le = NULL, suspendu_motif = NULL, suspendu_par = NULL
        WHERE id = $1 AND suspendu_le IS NOT NULL
        RETURNING id`,
      [id]
    );
    if (!rows[0]) return res.status(409).json({ erreur: "Ce compte n'est pas suspendu." });

    parAdmin(req, {
      action: "compte_reactive",
      cibleType: "proprietaire",
      cibleId: id,
      proprietaireId: id,
      details: {},
    });

    res.json({ id, suspendu: false });
  } catch (erreur) {
    console.error("Erreur réactivation :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// POST /api/admin/clients/:id/reinitialiser-pin
//
// Efface le PIN et délivre un nouveau lien : le propriétaire recrée son
// code lui-même. SEDAP ne choisit jamais le PIN de quelqu'un.
async function reinitialiserPinClient(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erreur: "Identifiant invalide." });

  try {
    const jeton = crypto.randomBytes(32).toString("base64url");
    const { rows } = await pool.query(
      `UPDATE proprietaires
          SET pin_hash = NULL, tentatives_echouees = 0, compte_verrouille = false,
              jeton_activation = $2, jeton_expire_le = now() + ($3 || ' days')::interval
        WHERE id = $1
        RETURNING id, prenom, nom, jeton_expire_le`,
      [id, jeton, String(JOURS_VALIDITE_LIEN)]
    );
    if (!rows[0]) return res.status(404).json({ erreur: "Propriétaire introuvable." });

    parAdmin(req, {
      action: "pin_reinitialise",
      cibleType: "proprietaire",
      cibleId: id,
      proprietaireId: id,
      details: {},
    });

    res.json({ id, activation: lienActivation(jeton, rows[0], "pin") });
  } catch (erreur) {
    console.error("Erreur réinitialisation PIN :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// POST /api/admin/clients/:id/renvoyer-lien
//
// L'ancien lien est invalidé (cahier VII) : deux liens valables en même
// temps, c'est un lien de trop qui traîne dans une boîte mail.
async function renvoyerLien(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erreur: "Identifiant invalide." });

  try {
    const { rows: etat } = await pool.query("SELECT pin_hash FROM proprietaires WHERE id = $1", [id]);
    if (!etat[0]) return res.status(404).json({ erreur: "Propriétaire introuvable." });
    if (etat[0].pin_hash) {
      return res.status(409).json({
        erreur: "Ce compte est déjà activé. Utilisez « Réinitialiser le PIN » si besoin.",
      });
    }

    const jeton = crypto.randomBytes(32).toString("base64url");
    const { rows } = await pool.query(
      `UPDATE proprietaires
          SET jeton_activation = $2, jeton_expire_le = now() + ($3 || ' days')::interval
        WHERE id = $1
        RETURNING id, prenom, nom, jeton_expire_le`,
      [id, jeton, String(JOURS_VALIDITE_LIEN)]
    );

    parAdmin(req, {
      action: "lien_renvoye",
      cibleType: "proprietaire",
      cibleId: id,
      proprietaireId: id,
      details: {},
    });

    res.json({ id, activation: lienActivation(jeton, rows[0]) });
  } catch (erreur) {
    console.error("Erreur renvoi du lien :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = {
  listeClients,
  creerClient,
  ficheClient,
  modifierClient,
  suspendreClient,
  reactiverClient,
  reinitialiserPinClient,
  renvoyerLien,
};
