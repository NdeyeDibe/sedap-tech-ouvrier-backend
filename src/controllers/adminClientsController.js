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
  if (p.compte_verrouille) return "verrouille";
  if (!p.pin_hash) return "en_attente";
  return "actif";
}

// GET /api/admin/clients?recherche=…&compte=…
//
// La recherche porte sur le nom, le téléphone et l'e-mail : c'est par l'un
// des trois que SEDAP retrouve quelqu'un au téléphone.
async function listeClients(req, res) {
  const recherche = String(req.query.recherche ?? "").trim();
  const compte = String(req.query.compte ?? "").trim();

  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.prenom, p.nom, p.telephone, p.email, p.cree_le,
              p.pin_hash, p.compte_verrouille,
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
        ORDER BY p.prenom, p.nom`
    );

    // Filtres appliqués ici plutôt qu'en SQL : la liste des clients de
    // SEDAP se compte en dizaines, et le code reste lisible.
    const sansAccents = (t) =>
      String(t ?? "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase();
    const chiffres = (t) => String(t ?? "").replace(/\D/g, "");

    const clients = rows
      .map((p) => ({
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
      }))
      .filter((c) => {
        if (compte && c.compte !== compte) return false;
        if (!recherche) return true;
        const aiguille = sansAccents(recherche);
        const nombres = chiffres(recherche);
        return (
          sansAccents(`${c.prenom} ${c.nom}`).includes(aiguille) ||
          sansAccents(c.email).includes(aiguille) ||
          sansAccents(c.ferme?.nom).includes(aiguille) ||
          (nombres.length >= 3 && chiffres(c.telephone).includes(nombres))
        );
      });

    res.json({
      clients,
      // Pour les compteurs du filtre, calculés sur la liste complète.
      total: rows.length,
    });
  } catch (erreur) {
    console.error("Erreur liste des clients :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
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
function lienActivation(jeton, proprietaire) {
  const lien = URL_PROPRIETAIRE
    ? `${URL_PROPRIETAIRE.replace(/\/$/, "")}/activation?jeton=${jeton}`
    : null;

  const message =
    `Bonjour ${proprietaire.prenom}, votre espace SEDAP'Tech est prêt. ` +
    (lien ? `Ouvrez ${lien} ` : "Ouvrez l'application SEDAP'Tech ") +
    `pour confirmer votre numéro et choisir votre code à 4 chiffres. ` +
    `Ce lien est valable 7 jours.`;

  return { jeton, lien, message, expireLe: proprietaire.jeton_expire_le };
}

module.exports = { listeClients, creerClient };
