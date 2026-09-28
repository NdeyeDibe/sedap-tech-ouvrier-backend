const pool = require("../db/pool");
const { parAdmin } = require("../services/journal");
const seuils = require("../services/seuils");

// Programme sanitaire de référence — cahier admin, maquette 21.
//
// Ce programme est le MODÈLE. Chaque bande en reçoit une copie à son
// démarrage (migration 024) : le modifier ici ne touche aucune bande en
// cours. C'est ce que promet le bandeau de la maquette, et c'est
// indispensable — déplacer un vaccin de J9 à J10 sur une bande arrivée à
// J20 mettrait rétroactivement en retard un acte déjà fait.
//
// Réservé à l'admin principal : ce programme s'applique à toutes les fermes.

const TYPES = ["vaccin", "traitement", "pesage"];

const texte = (v) => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};

const entier = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined; // undefined = invalide
};

// GET /api/admin/programme
async function lireProgramme(req, res) {
  try {
    const [{ rows: actes }, { rows: compteur }] = await Promise.all([
      pool.query(
        `SELECT id, ordre, nom, type, jour_debut, jour_fin,
                produits, administration, poids_min_g, poids_max_g
           FROM programme_sanitaire ORDER BY ordre`
      ),
      pool.query("SELECT count(*)::int AS actives FROM bandes WHERE statut <> 'terminee'"),
    ]);

    res.json({
      actes: actes.map(normaliser),
      // Le bandeau annonce combien de bandes gardent leur programme : sans
      // ce chiffre, la phrase reste abstraite.
      bandesActives: compteur[0].actives,
      // Le poids minimal des poussins à la réception est un seuil, pas un
      // acte : il vit avec les autres réglages (migration 023).
      poidsMinReceptionG: seuils.seuilsActuels().poids_min_reception_g,
    });
  } catch (erreur) {
    console.error("Erreur lecture du programme :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

const normaliser = (a) => ({
  id: a.id,
  ordre: a.ordre,
  nom: a.nom,
  type: a.type,
  jourDebut: a.jour_debut,
  jourFin: a.jour_fin,
  produits: a.produits ?? [],
  administration: a.administration,
  poidsMinG: a.poids_min_g,
  poidsMaxG: a.poids_max_g,
});

// Valide un acte, quel que soit le sens (création ou modification).
function verifier(corps) {
  const nom = texte(corps.nom);
  const type = texte(corps.type);
  const jourDebut = entier(corps.jourDebut);
  const jourFin = entier(corps.jourFin);
  const poidsMinG = entier(corps.poidsMinG);
  const poidsMaxG = entier(corps.poidsMaxG);

  if (!nom) return { erreur: "Le nom de l'acte est obligatoire." };
  if (!TYPES.includes(type)) {
    return { erreur: "Type attendu : vaccin, traitement ou pesage." };
  }
  if (!Number.isInteger(jourDebut) || jourDebut < 1 || jourDebut > 120) {
    return { erreur: "Jour de début attendu entre 1 et 120." };
  }
  if (jourFin === undefined || (jourFin !== null && (jourFin < jourDebut || jourFin > 120))) {
    return { erreur: "Jour de fin attendu entre le jour de début et 120." };
  }
  if (poidsMinG === undefined || poidsMaxG === undefined) {
    return { erreur: "Poids attendu en grammes entiers." };
  }
  if (poidsMinG !== null && poidsMaxG !== null && poidsMinG > poidsMaxG) {
    return { erreur: "Le poids minimal doit rester sous le poids maximal." };
  }

  const produits = Array.isArray(corps.produits)
    ? corps.produits.map(texte).filter(Boolean)
    : [];

  return {
    valeurs: {
      nom,
      type,
      jourDebut,
      jourFin,
      produits,
      administration: texte(corps.administration),
      // Un poids attendu n'a de sens que pour un pesage : le garder sur un
      // vaccin afficherait une fourchette que personne ne contrôle.
      poidsMinG: type === "pesage" ? poidsMinG : null,
      poidsMaxG: type === "pesage" ? poidsMaxG : null,
    },
  };
}

// POST /api/admin/programme
async function ajouterActe(req, res) {
  const { erreur, valeurs } = verifier(req.body);
  if (erreur) return res.status(400).json({ erreur });

  try {
    // L'ordre suit le jour de début : un acte ajouté à J10 se range entre
    // J9 et J14 sans qu'on ait à le déplacer à la main.
    const { rows } = await pool.query(
      `INSERT INTO programme_sanitaire
         (nom, type, jour_debut, jour_fin, produits, administration, poids_min_g, poids_max_g, ordre)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               (SELECT coalesce(max(ordre), 0) + 1 FROM programme_sanitaire))
       RETURNING id, ordre, nom, type, jour_debut, jour_fin, produits,
                 administration, poids_min_g, poids_max_g`,
      [
        valeurs.nom,
        valeurs.type,
        valeurs.jourDebut,
        valeurs.jourFin,
        valeurs.produits,
        valeurs.administration,
        valeurs.poidsMinG,
        valeurs.poidsMaxG,
      ]
    );

    await reordonner();

    parAdmin(req, {
      action: "programme_modifie",
      cibleType: "programme",
      cibleId: rows[0].id,
      details: { ajout: valeurs },
    });

    res.status(201).json({ acte: normaliser(rows[0]) });
  } catch (erreur) {
    console.error("Erreur ajout d'acte :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// PATCH /api/admin/programme/:id
async function modifierActe(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erreur: "Identifiant invalide." });

  const { erreur, valeurs } = verifier(req.body);
  if (erreur) return res.status(400).json({ erreur });

  try {
    const { rows: avant } = await pool.query(
      `SELECT nom, type, jour_debut, jour_fin, produits, administration,
              poids_min_g, poids_max_g
         FROM programme_sanitaire WHERE id = $1`,
      [id]
    );
    if (!avant[0]) return res.status(404).json({ erreur: "Acte introuvable." });

    const { rows } = await pool.query(
      `UPDATE programme_sanitaire
          SET nom = $2, type = $3, jour_debut = $4, jour_fin = $5, produits = $6,
              administration = $7, poids_min_g = $8, poids_max_g = $9
        WHERE id = $1
        RETURNING id, ordre, nom, type, jour_debut, jour_fin, produits,
                  administration, poids_min_g, poids_max_g`,
      [
        id,
        valeurs.nom,
        valeurs.type,
        valeurs.jourDebut,
        valeurs.jourFin,
        valeurs.produits,
        valeurs.administration,
        valeurs.poidsMinG,
        valeurs.poidsMaxG,
      ]
    );

    await reordonner();

    parAdmin(req, {
      action: "programme_modifie",
      cibleType: "programme",
      cibleId: id,
      details: { avant: normaliser({ ...avant[0], id, ordre: rows[0].ordre }), apres: valeurs },
    });

    res.json({ acte: normaliser(rows[0]) });
  } catch (erreur) {
    console.error("Erreur modification d'acte :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// DELETE /api/admin/programme/:id
async function supprimerActe(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erreur: "Identifiant invalide." });

  try {
    const { rows } = await pool.query(
      "DELETE FROM programme_sanitaire WHERE id = $1 RETURNING nom, type, jour_debut",
      [id]
    );
    if (!rows[0]) return res.status(404).json({ erreur: "Acte introuvable." });

    await reordonner();

    // Les bandes en cours gardent l'acte : leur copie n'est pas touchée.
    parAdmin(req, {
      action: "programme_modifie",
      cibleType: "programme",
      cibleId: id,
      details: { suppression: rows[0] },
    });

    res.json({ supprime: true });
  } catch (erreur) {
    console.error("Erreur suppression d'acte :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// L'ordre doit rester continu et suivre le calendrier : c'est lui qui
// classe le programme à l'écran de l'ouvrier comme ici.
async function reordonner() {
  await pool.query(`
    WITH classe AS (
      SELECT id, row_number() OVER (ORDER BY jour_debut, type, nom) AS rang
        FROM programme_sanitaire
    )
    UPDATE programme_sanitaire ps
       SET ordre = classe.rang + 1000
      FROM classe WHERE classe.id = ps.id
  `);
  // Deux passes : l'unicité de `ordre` interdit de croiser deux valeurs en
  // une seule mise à jour. Le décalage de 1000 libère la plage basse.
  await pool.query("UPDATE programme_sanitaire SET ordre = ordre - 1000");
}

module.exports = { lireProgramme, ajouterActe, modifierActe, supprimerActe };
