const pool = require("../db/pool");
const { parAdmin } = require("../services/journal");
const { flaconsParFormat, totalDoses } = require("../services/flacons");

// Barème de référence du poids moyen, identique à celui du responsable
// (suiviController) et de l'application. Dupliqué ici plutôt qu'importé :
// ces trois copies doivent rester synchronisées, et un commentaire visible
// vaut mieux qu'une dépendance qu'on oublie.
const TABLE_PESAGE = [
  { jour: 0, min: 35, max: null },
  { jour: 7, min: 160, max: 220 },
  { jour: 14, min: 450, max: 600 },
  { jour: 21, min: 800, max: 1000 },
  { jour: 28, min: 1250, max: 1550 },
  { jour: 35, min: 1700, max: 2200 },
];

const referencePesage = (jour) => {
  const passees = TABLE_PESAGE.filter((r) => r.jour <= jour);
  return passees[passees.length - 1] || TABLE_PESAGE[0];
};

/**
 * L'ACTE VISÉ, ET POURQUOI ON LE DÉSIGNE PAR SON RANG.
 *
 * Le programme contient trois actes nommés « Antistress » — J9-J11,
 * J14-J16, J21-J22 — et deux « Vitamine ». Le nom ne désigne donc rien à
 * lui seul : c'est `ordre` qui identifie un acte dans le programme d'une
 * bande. Le type et le nom sont lus en base et jamais pris du client :
 * c'est le programme qui dit ce qu'on est en train de déclarer.
 */
async function chargerActe(client, bandeId, ordre) {
  const { rows } = await client.query(
    `SELECT pa.ordre, pa.nom, pa.type, pa.jour_debut, pa.jour_fin, pa.produits,
            b.date_debut::date AS debut,
            (CURRENT_DATE - b.date_debut::date) + 1 AS jour_actuel,
            b.poulailler_id
       FROM programme_actes_bande pa
       JOIN bandes b ON b.id = pa.bande_id
      WHERE pa.bande_id = $1 AND pa.ordre = $2`,
    [bandeId, ordre]
  );
  return rows[0] ?? null;
}

/**
 * Le stock a-t-il DÉJÀ bougé pour cet acte ?
 *
 * Avant que les vaccins et traitements aient leurs propres écrans, le
 * responsable les sortait par « Produits utilisés ». Ces sorties-là sont
 * réelles : redéduire en déclarant l'acte creuserait un trou dans le
 * stock pour un produit administré une seule fois — c'est ce qui est
 * arrivé au Gumboro L de la bande 22, sorti deux fois le même jour.
 *
 * On regarde donc s'il existe une sortie de stock correspondant à cet
 * acte dans sa fenêtre. Si oui, on enregistre l'acte sans toucher au
 * stock, et on le dit à SEDAP plutôt que de le décider en silence.
 */
async function stockDejaSorti(client, bandeId, acte) {
  const dernierJour = acte.jour_fin ?? acte.jour_debut;
  const { rows } = await client.query(
    `SELECT pu.id, pu.date_saisie::date AS le, pu.quantite,
            COALESCE(sp.nom, sa.nom) AS produit
       FROM produits_utilises pu
       JOIN bandes b ON b.id = pu.bande_id
       LEFT JOIN stock_produits sp        ON sp.id = pu.stock_produit_id
       LEFT JOIN stock_autres_produits sa ON sa.id = pu.stock_autre_produit_id
      WHERE pu.bande_id = $1
        AND (pu.date_saisie - b.date_debut::date + 1) BETWEEN $2 AND $3
        AND (
          COALESCE(sp.nom, sa.nom) ILIKE $4
          OR (sp.produit_id = 'vitamines'  AND $4 ILIKE '%vitamine%')
          OR (sp.produit_id = 'antistress' AND $4 ILIKE '%antistress%')
        )
      ORDER BY pu.date_saisie
      LIMIT 1`,
    [bandeId, acte.jour_debut, dernierJour, acte.nom]
  );
  return rows[0] ?? null;
}

/**
 * GET /api/admin/bandes/:bandeId/actes/:ordre
 *
 * Ce que SEDAP doit voir AVANT de déclarer : l'acte, son état, ce qu'il
 * reste en stock, et surtout si le stock a déjà bougé. La fenêtre de
 * déclaration annonce ce qu'elle va faire au stock au lieu de le faire
 * en silence — on ne décide pas de retirer 4 000 doses sans le dire.
 */
async function apercuActe(req, res) {
  const { bandeId, ordre } = req.params;
  const client = await pool.connect();
  try {
    const acte = await chargerActe(client, bandeId, ordre);
    if (!acte) return res.status(404).json({ erreur: "Acte introuvable." });

    const dejaSorti = await stockDejaSorti(client, bandeId, acte);

    // Les produits qui peuvent servir à cet acte, avec ce qu'il en reste.
    // Pour un vaccin, le détail par contenance : un flacon ne se coupe
    // pas en deux, SEDAP choisit des flacons entiers comme le ferait le
    // responsable.
    // UN VACCIN N'EN VAUT PAS UN AUTRE. Filtrer sur la seule famille
    // « vaccin » proposait Gumboro L pour l'acte Gumboro IBDL : déclarer
    // l'un aurait déduit les doses de l'autre, et le stock des deux
    // serait devenu faux d'un coup (relevé le 27 nov. 2026). On rapproche
    // donc le nom du produit de celui de l'acte, ou des marques que le
    // programme associe à cet acte.
    //
    // Si rien ne correspond, on renvoie quand même la famille entière
    // plutôt que de bloquer SEDAP : un vaccin peut être enregistré sous
    // un nom de marque qu'on n'a pas prévu. L'écran le signale alors.
    const familles = famillesPossibles(acte);
    const { rows: correspondants } = await client.query(
      `SELECT sp.id, sp.produit_id, sp.variante_id, sp.nom, sp.unite, sp.quantite
         FROM stock_produits sp
        WHERE sp.poulailler_id = $1 AND sp.quantite > 0
          AND sp.produit_id = ANY($2::text[])
          AND (
            sp.nom ILIKE $3
            OR EXISTS (SELECT 1 FROM unnest($4::text[]) AS marque
                        WHERE sp.nom ILIKE '%' || marque || '%')
          )
        ORDER BY sp.nom`,
      [acte.poulailler_id, familles, acte.nom, acte.produits ?? []]
    );

    const { rows: toutesLesFamilles } = await client.query(
      `SELECT sp.id, sp.produit_id, sp.variante_id, sp.nom, sp.unite, sp.quantite
         FROM stock_produits sp
        WHERE sp.poulailler_id = $1 AND sp.quantite > 0
          AND sp.produit_id = ANY($2::text[])
        ORDER BY sp.nom`,
      [acte.poulailler_id, familles]
    );

    const produits = correspondants.length > 0 ? correspondants : toutesLesFamilles;
    const produitsElargis = correspondants.length === 0 && toutesLesFamilles.length > 0;

    const avecFormats = await Promise.all(
      produits.map(async (p) =>
        p.produit_id === "vaccin"
          ? { ...p, formats: await flaconsParFormat(client, p.id) }
          : p
      )
    );

    const { rows: autres } = await client.query(
      `SELECT id, COALESCE(nom, 'Sans nom') AS nom, quantite, photo_url
         FROM stock_autres_produits
        WHERE poulailler_id = $1 AND quantite > 0
        ORDER BY id DESC`,
      [acte.poulailler_id]
    );

    res.json({
      ordre: acte.ordre,
      nom: acte.nom,
      type: acte.type,
      jourDebut: acte.jour_debut,
      jourFin: acte.jour_fin ?? acte.jour_debut,
      jourActuel: acte.jour_actuel,
      produits: avecFormats,
      // Vrai quand aucun produit ne porte le nom de l'acte et qu'on a
      // élargi à toute la famille : l'écran doit alors prévenir qu'il
      // faut vérifier qu'on ne déduit pas le mauvais vaccin.
      produitsElargis,
      autresProduits: autres,
      // Non nul quand le produit est déjà sorti du stock pour cet acte :
      // la déclaration ne déduira alors rien.
      stockDejaSorti: dejaSorti,
    });
  } catch (erreur) {
    console.error("Erreur aperçu de l'acte :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

// Les familles du catalogue qui peuvent confirmer cet acte, d'après son
// nom. « Anticoccidien » n'en a aucune : il n'existe pas au catalogue et
// s'achète en pharmacie, donc il passe par les « autres produits ».
function famillesPossibles(acte) {
  if (acte.type === "vaccin") return ["vaccin"];
  const n = acte.nom.toLowerCase();
  const familles = [];
  if (n.includes("vitamine")) familles.push("vitamines");
  if (n.includes("antistress")) familles.push("antistress");
  return familles.length > 0 ? familles : ["__aucune__"];
}

/**
 * POST /api/admin/bandes/:bandeId/actes/:ordre
 *
 * SEDAP déclare qu'un acte passé a bien été administré.
 *
 * POURQUOI CETTE ROUTE EXISTE. Le responsable ne déclare un acte que
 * pendant sa fenêtre : à J9 pour un vaccin prévu à J9, de J9 à J11 pour
 * un antistress. Passé ce délai il ne peut plus rien saisir — c'est la
 * règle d'intégrité qui gouverne déjà les journées oubliées, et elle est
 * juste : une déclaration tardive n'est pas vérifiable par celui qui l'a
 * oubliée. Mais sans recours, un soin réellement administré restait
 * rouge jusqu'à la fin de la bande (décision Ndeye, 22 nov. 2026).
 *
 * LE MOTIF EST OBLIGATOIRE et le propriétaire le voit. Déclarer un acte
 * après coup, c'est affirmer quelque chose qu'aucune saisie ne prouve :
 * la trace de qui l'a affirmé et pourquoi fait partie de l'acte.
 */
async function declarerActe(req, res) {
  const { bandeId, ordre } = req.params;
  const { jourBande, motif } = req.body;

  if (!motif || String(motif).trim().length < 3) {
    return res.status(400).json({ erreur: "Le motif de la déclaration est requis." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const acte = await chargerActe(client, bandeId, ordre);
    if (!acte) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erreur: "Acte introuvable." });
    }

    const jour = Number(jourBande ?? acte.jour_debut);
    if (!Number.isInteger(jour) || jour < 1 || jour > acte.jour_actuel) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        erreur:
          `Le jour doit être compris entre 1 et ${acte.jour_actuel}, ` +
          `le jour où en est la bande. On ne déclare pas un soin à venir.`,
      });
    }

    const resultat =
      acte.type === "pesage"
        ? await declarerPesage(client, bandeId, acte, jour, req.body)
        : await declarerSoin(client, bandeId, acte, jour, req.body);

    await client.query("COMMIT");

    parAdmin(req, {
      action: "acte_declare",
      cibleType: "bande",
      cibleId: Number(bandeId),
      details: {
        acte: acte.nom,
        type: acte.type,
        jour,
        motif: String(motif).trim(),
        ...resultat.journal,
      },
    });

    res.status(201).json(resultat.reponse);
  } catch (erreur) {
    await client.query("ROLLBACK");
    if (erreur.statut) return res.status(erreur.statut).json({ erreur: erreur.message });
    console.error("Erreur déclaration de l'acte :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  } finally {
    client.release();
  }
}

/**
 * Un pesage : on enregistre le poids, ou on corrige celui déjà saisi.
 *
 * Les deux cas passent par ici parce que c'est le même geste pour SEDAP
 * — « le poids de ce jour-là est faux ou manquant » — et parce que
 * `dans_fourchette` doit être recalculé dans les deux cas. Rien à
 * déduire : peser ne consomme pas de stock.
 */
async function declarerPesage(client, bandeId, acte, jour, corps) {
  const poidsG = Number(corps.poidsG);
  if (!Number.isFinite(poidsG) || poidsG <= 0) {
    throw { statut: 400, message: "Le poids moyen en grammes est requis." };
  }

  const reference = referencePesage(jour);
  const dansFourchette =
    poidsG >= reference.min && (reference.max === null || poidsG <= reference.max);

  const { rows: existant } = await client.query(
    "SELECT id, poids_g FROM pesages WHERE bande_id = $1 AND jour_bande = $2",
    [bandeId, jour]
  );

  if (existant[0]) {
    await client.query(
      "UPDATE pesages SET poids_g = $2, dans_fourchette = $3 WHERE id = $1",
      [existant[0].id, poidsG, dansFourchette]
    );
    return {
      reponse: { corrige: true, poidsG, dansFourchette },
      journal: { poids_g: { avant: existant[0].poids_g, apres: poidsG } },
    };
  }

  await client.query(
    `INSERT INTO pesages (bande_id, jour_bande, poids_g, dans_fourchette, date_saisie)
     VALUES ($1, $2, $3, $4, CURRENT_DATE)`,
    [bandeId, jour, poidsG, dansFourchette]
  );
  return {
    reponse: { corrige: false, poidsG, dansFourchette },
    journal: { poids_g: { avant: null, apres: poidsG } },
  };
}

/**
 * Un vaccin ou un traitement : on enregistre l'acte et on retire le
 * produit du stock — sauf s'il en est déjà sorti.
 */
async function declarerSoin(client, bandeId, acte, jour, corps) {
  const { rows: deja } = await client.query(
    `SELECT id FROM vaccinations
      WHERE bande_id = $1 AND lower(vaccin_nom) = lower($2) AND jour_bande = $3`,
    [bandeId, acte.nom, jour]
  );
  if (deja[0]) {
    throw {
      statut: 409,
      message: `${acte.nom} est déjà déclaré au jour ${jour} pour cette bande.`,
    };
  }

  const dejaSorti = await stockDejaSorti(client, bandeId, acte);

  let stockProduitId = null;
  let stockAutreId = null;
  let quantite = null;
  let detailFlacons = null;

  if (acte.type === "vaccin") {
    const lignes = Array.isArray(corps.flacons) ? corps.flacons : [];
    detailFlacons = lignes
      .map((l) => ({ doses: Number(l.doses), flacons: Number(l.flacons) }))
      .filter((l) => Number.isFinite(l.doses) && l.flacons > 0);
    stockProduitId = Number(corps.stockProduitId) || null;
    if (!stockProduitId) throw { statut: 400, message: "Le vaccin utilisé est requis." };

    if (detailFlacons.length > 0) {
      quantite = totalDoses(detailFlacons);
    } else {
      // REPLI EN DOSES, et il n'est pas un relâchement de la règle du
      // flacon entier. Un vaccin reçu avant qu'on compte en flacons n'a
      // aucune contenance connue : il n'y a donc aucun flacon à proposer,
      // et sans ce repli l'acte deviendrait impossible à déclarer — il
      // resterait rouge jusqu'à la fin de la bande, c'est-à-dire
      // exactement le problème que ce rattrapage existe pour résoudre.
      detailFlacons = null;
      quantite = Number(corps.quantite);
      if (!(quantite > 0)) {
        throw {
          statut: 400,
          message: "Indiquez les flacons utilisés, ou à défaut le nombre de doses.",
        };
      }
    }
  } else if (corps.estAutre) {
    stockAutreId = Number(corps.autreProduitId) || null;
    quantite = Number(corps.quantite);
    if (!stockAutreId || !(quantite > 0)) {
      throw { statut: 400, message: "Le produit et la quantité sont requis." };
    }
  } else {
    stockProduitId = Number(corps.stockProduitId) || null;
    quantite = Number(corps.quantite);
    if (!stockProduitId || !(quantite > 0)) {
      throw { statut: 400, message: "Le produit et la quantité sont requis." };
    }
  }

  // La déduction, seulement si le produit n'est pas déjà sorti.
  if (!dejaSorti) {
    const table = stockAutreId ? "stock_autres_produits" : "stock_produits";
    const id = stockAutreId ?? stockProduitId;
    const { rows } = await client.query(
      `SELECT quantite, COALESCE(nom, 'ce produit') AS nom FROM ${table} WHERE id = $1`,
      [id]
    );
    if (!rows[0]) throw { statut: 400, message: "Produit introuvable." };
    if (Number(rows[0].quantite) < quantite) {
      throw {
        statut: 409,
        message:
          `Stock insuffisant : il reste ${rows[0].quantite} de ${rows[0].nom}, ` +
          `et la déclaration en retirerait ${quantite}.`,
      };
    }
    await client.query(`UPDATE ${table} SET quantite = quantite - $1 WHERE id = $2`, [
      quantite,
      id,
    ]);
  }

  const { rows: insere } = await client.query(
    `INSERT INTO vaccinations
       (bande_id, jour_bande, vaccin_nom, stock_produit_id, stock_autre_produit_id,
        quantite_utilisee, flacons_detail, doses_utilisees)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      bandeId,
      jour,
      acte.nom,
      stockProduitId,
      stockAutreId,
      quantite,
      detailFlacons ? JSON.stringify(detailFlacons) : null,
      acte.type === "vaccin" ? quantite : null,
    ]
  );

  return {
    reponse: {
      id: insere[0].id,
      quantite,
      stockDeduit: !dejaSorti,
      stockDejaSorti: dejaSorti,
    },
    journal: {
      quantite,
      stock_deduit: !dejaSorti,
      ...(dejaSorti ? { deja_sorti_le: dejaSorti.le } : {}),
    },
  };
}

module.exports = { apercuActe, declarerActe };
