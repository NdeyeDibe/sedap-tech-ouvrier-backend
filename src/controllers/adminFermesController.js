const pool = require("../db/pool");
const { chargerFerme } = require("../services/alertesFerme");
const { niveauLePlusGrave } = require("../utils/alertes");
const { creerStockInitial } = require("../utils/stockInitial");
const { parAdmin } = require("../services/journal");

// Détail d'une ferme — cahier admin v1.1, section VIII (maquette 07).
//
// Les bandes, effectifs et alertes viennent de chargerFerme(), exactement
// ce que voit le propriétaire : une ferme appartient à un seul propriétaire
// (cahier propriétaire v3), on la charge donc par lui.

// État du compte propriétaire, tel que l'affiche la fiche (cahier VII).
function etatCompte(p) {
  // La suspension prime : c'est une décision de SEDAP, pas un incident.
  if (p.suspendu_le) return "suspendu";
  if (p.compte_verrouille) return "verrouille";
  if (!p.pin_hash) return "en_attente";
  return "actif";
}

// GET /api/admin/fermes/:id
async function detailFerme(req, res) {
  const fermeId = Number(req.params.id);
  if (!Number.isInteger(fermeId)) {
    return res.status(400).json({ erreur: "Identifiant de ferme invalide." });
  }

  try {
    const { rows: fermes } = await pool.query(
      `SELECT f.id, f.nom, f.localite, f.cree_le,
              p.id AS proprietaire_id, p.prenom, p.nom AS proprietaire_nom,
              p.telephone, p.email, p.cree_le AS proprietaire_cree_le,
              p.pin_hash, p.compte_verrouille, p.suspendu_le
         FROM fermes f
         JOIN proprietaires p ON p.id = f.proprietaire_id
        WHERE f.id = $1`,
      [fermeId]
    );
    const f = fermes[0];
    if (!f) return res.status(404).json({ erreur: "Ferme introuvable." });

    const [lignes, { rows: complements }] = await Promise.all([
      chargerFerme(f.proprietaire_id),
      // Ce que chargerFerme ne donne pas : capacité, nom complet du
      // responsable, et date de la dernière saisie de chaque poulailler.
      pool.query(
        `SELECT pl.id, pl.capacite,
                o.id AS ouvrier_id, o.prenom AS ouvrier_prenom, o.nom AS ouvrier_nom,
                o.telephone AS ouvrier_telephone, (o.pin_hash IS NOT NULL) AS ouvrier_pin_cree,
                o.compte_verrouille AS ouvrier_verrouille,
                (SELECT max(d) FROM (
                   SELECT max(sm.date_saisie) AS d FROM saisies_mortalite sm
                     JOIN bandes b ON b.id = sm.bande_id WHERE b.poulailler_id = pl.id
                   UNION ALL
                   SELECT max(ss.date_saisie) FROM saisies_sante ss
                     JOIN bandes b ON b.id = ss.bande_id WHERE b.poulailler_id = pl.id
                   UNION ALL
                   SELECT max(sa.date_saisie) FROM saisies_alimentation sa
                     JOIN bandes b ON b.id = sa.bande_id WHERE b.poulailler_id = pl.id
                 ) dates) AS derniere_saisie
           FROM poulaillers pl
           LEFT JOIN personnel pe
             ON pe.poulailler_id = pl.id AND pe.role = 'responsable' AND pe.fin_fonction IS NULL
           LEFT JOIN ouvriers o ON o.id = pe.ouvrier_id
          WHERE pl.ferme_id = $1 AND pl.archive_le IS NULL`,
        [fermeId]
      ),
    ]);

    const parPoulailler = new Map(complements.map((c) => [c.id, c]));

    const poulaillers = lignes
      .filter((l) => l.ferme_id === fermeId)
      .map((l) => {
        const c = parPoulailler.get(l.poulailler_id) ?? {};
        return {
          id: l.poulailler_id,
          nom: l.poulailler_nom ?? `Poulailler ${l.poulailler_id}`,
          capacite: c.capacite ?? null,
          responsable: c.ouvrier_id
            ? {
                id: c.ouvrier_id,
                prenom: c.ouvrier_prenom,
                nom: c.ouvrier_nom,
                telephone: c.ouvrier_telephone,
                pinCree: c.ouvrier_pin_cree,
                // Même vocabulaire que le compte du propriétaire, pour que
                // l'écran affiche les deux de la même façon.
                compte: etatCompte({
                  compte_verrouille: c.ouvrier_verrouille,
                  pin_hash: c.ouvrier_pin_cree ? "x" : null,
                }),
              }
            : null,
          bande: l.bande_id
            ? {
                id: l.bande_id,
                numero: l.bande_numero,
                statut: l.statut,
                ageJours: Number(l.age_jours),
                vivants: Number(l.restant),
                morts: Number(l.morts),
                tauxMortalite: l.taux_mortalite == null ? 0 : Number(l.taux_mortalite),
              }
            : null,
          statut: l.niveau,
          alertes: l.alertes.length,
          derniereSaisie: c.derniere_saisie ?? null,
        };
      });

    const alertes = lignes
      .filter((l) => l.ferme_id === fermeId)
      .flatMap((l) =>
        l.alertes.map((a) => ({
          type: a.type,
          niveau: a.niveau,
          titre: a.titre,
          message: a.message,
          bandeId: l.bande_id,
          poulailler: { id: l.poulailler_id, nom: l.poulailler_nom },
        }))
      )
      // Les urgentes d'abord, toutes poulaillers confondus.
      .sort((a, b) => (a.niveau === "urgent" ? 0 : 1) - (b.niveau === "urgent" ? 0 : 1));

    const actifs = poulaillers.filter((p) => p.bande);

    res.json({
      ferme: { id: f.id, nom: f.nom, localite: f.localite, creeLe: f.cree_le },
      proprietaire: {
        id: f.proprietaire_id,
        prenom: f.prenom,
        nom: f.proprietaire_nom,
        telephone: f.telephone,
        email: f.email,
        clientDepuis: f.proprietaire_cree_le,
        compte: etatCompte(f),
      },
      statut: niveauLePlusGrave(poulaillers.map((p) => p.statut)),
      chiffres: {
        poulaillers: poulaillers.length,
        enVente: actifs.filter((p) => p.bande.statut === "en_vente").length,
        sujetsVivants: actifs.reduce((t, p) => t + p.bande.vivants, 0),
        mortsBandesActives: actifs.reduce((t, p) => t + p.bande.morts, 0),
        alertes: alertes.length,
        urgentes: alertes.filter((a) => a.niveau === "urgent").length,
        aSurveiller: alertes.filter((a) => a.niveau !== "urgent").length,
      },
      // Cahier VIII : une bande active sans responsable est signalée en
      // haut de la fiche — plus personne ne fait les saisies.
      bandesSansResponsable: poulaillers.filter((p) => p.bande && !p.responsable).length,
      poulaillers,
      alertes,
    });
  } catch (erreur) {
    console.error("Erreur détail ferme :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

/**
 * Le premier « Poulailler N » libre, quand l'écran n'a pas donné de nom.
 *
 * On compte les numéros pris et non les poulaillers : une ferme qui a
 * « Poulailler 1 » et « Bâtiment Nord » doit proposer 2, pas 3.
 */
function premierNumeroLibre(existants) {
  const pris = new Set(
    existants
      .map((p) => /^poulailler\s+(\d+)$/i.exec(String(p.nom ?? "").trim())?.[1])
      .filter(Boolean)
      .map(Number)
  );
  let n = 1;
  while (pris.has(n)) n += 1;
  return `Poulailler ${n}`;
}

// POST /api/admin/fermes/:id/poulaillers
//
// Une ferme s'agrandit : le propriétaire construit un bâtiment de plus, et
// il faut pouvoir l'enregistrer sans recréer le client. Jusqu'ici les
// poulaillers ne naissaient qu'à la création du compte (cahier VII).
//
// Le poulailler arrive vide et sans responsable : c'est ensuite « Ajouter
// un responsable » sur la fiche de la ferme, puis l'ouvrier démarre sa
// première bande. Son catalogue de stock est créé tout de suite, sinon
// l'ouvrier ne pourrait rien déclarer à sa première réception.
async function ajouterPoulailler(req, res) {
  const fermeId = Number(req.params.id);
  if (!Number.isInteger(fermeId)) {
    return res.status(400).json({ erreur: "Identifiant de ferme invalide." });
  }

  const nomDemande = String(req.body.nom ?? "").trim();
  const brut = req.body.capacite;
  const capacite = brut === null || brut === undefined || brut === "" ? null : Number(brut);

  if (capacite !== null && (!Number.isInteger(capacite) || capacite <= 0)) {
    return res.status(400).json({
      erreur: "Capacité invalide : un nombre de sujets supérieur à 0 est attendu.",
    });
  }

  const client = await pool.connect();
  try {
    const { rows: fermes } = await client.query("SELECT id FROM fermes WHERE id = $1", [fermeId]);
    if (!fermes[0]) return res.status(404).json({ erreur: "Ferme introuvable." });

    // Les noms servent à l'ouvrier comme au propriétaire pour se repérer :
    // deux « Poulailler 2 » dans la même ferme rendraient toute alerte
    // ambiguë. Les archivés ne comptent pas, leur nom se réutilise.
    const { rows: existants } = await client.query(
      `SELECT nom FROM poulaillers WHERE ferme_id = $1 AND archive_le IS NULL`,
      [fermeId]
    );

    const nom = nomDemande || premierNumeroLibre(existants);

    const pris = existants.some(
      (p) => (p.nom ?? "").trim().toLowerCase() === nom.toLowerCase()
    );
    if (pris) {
      return res.status(409).json({
        erreur: `Cette ferme a déjà un poulailler nommé « ${nom} ».`,
      });
    }

    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO poulaillers (ferme_id, nom, capacite)
       VALUES ($1, $2, $3)
       RETURNING id, nom, capacite, cree_le`,
      [fermeId, nom, capacite]
    );
    const poulailler = rows[0];

    await creerStockInitial(client, poulailler.id);

    await client.query("COMMIT");

    parAdmin(req, {
      action: "poulailler_ajoute",
      cibleType: "poulailler",
      cibleId: poulailler.id,
      fermeId,
      poulaillerId: poulailler.id,
      details: { nom, capacite },
    });

    res.status(201).json({
      poulailler: {
        id: poulailler.id,
        nom: poulailler.nom,
        capacite: poulailler.capacite,
        creeLe: poulailler.cree_le,
      },
    });
  } catch (erreur) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Erreur ajout de poulailler :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

module.exports = { detailFerme, ajouterPoulailler };
