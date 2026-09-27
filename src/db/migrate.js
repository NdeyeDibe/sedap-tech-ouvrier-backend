const fs = require("fs");
const path = require("path");
const pool = require("./pool");

// Les fichiers .sql de ce dossier, joués dans l'ordre alphabétique.
// D'où la numérotation : 002_ passe après schema.sql, 003_ après 002_.
const DOSSIER = __dirname;

// Verrou partagé le temps des migrations. Un déploiement Railway peut
// démarrer une nouvelle instance pendant que l'ancienne tourne encore :
// sans ce verrou, les deux essaieraient d'appliquer le même fichier en
// même temps, et la seconde échouerait sur la clé du journal. Avec lui,
// elle attend son tour puis constate qu'il n'y a plus rien à faire.
// Le nombre n'a pas de sens particulier, il identifie juste ce verrou-ci.
const CLE_VERROU = 918273645;

function fichiersSql() {
  return fs
    .readdirSync(DOSSIER)
    .filter((nom) => nom.endsWith(".sql"))
    .sort((a, b) => {
      // schema.sql pose les tables : il passe toujours en premier.
      if (a === "schema.sql") return -1;
      if (b === "schema.sql") return 1;
      return a.localeCompare(b);
    });
}

// Journal des migrations déjà appliquées. Sans lui, chaque démarrage
// rejouerait tout — inoffensif pour un CREATE IF NOT EXISTS, beaucoup
// moins pour un futur UPDATE de reprise de données.
async function preparerJournal() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations_appliquees (
      nom TEXT PRIMARY KEY,
      applique_le TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function dejaAppliquees() {
  const { rows } = await pool.query("SELECT nom FROM migrations_appliquees");
  return new Set(rows.map((r) => r.nom));
}

async function appliquer(detaille) {
  await preparerJournal();
  const faites = await dejaAppliquees();

  let appliquees = 0;

  for (const nom of fichiersSql()) {
    if (faites.has(nom)) {
      // Au démarrage du serveur on se tait : vingt lignes « déjà appliqué »
      // à chaque redémarrage noieraient ce qui compte dans les logs.
      if (detaille) console.log(`⏭  ${nom} — déjà appliqué`);
      continue;
    }

    const sql = fs.readFileSync(path.join(DOSSIER, nom), "utf-8");
    console.log(`▶  ${nom}`);

    // Chaque fichier dans sa propre transaction : en cas d'échec, il est
    // annulé entièrement et n'est pas inscrit au journal. Les fichiers
    // précédents, eux, restent acquis.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO migrations_appliquees (nom) VALUES ($1)", [nom]);
      await client.query("COMMIT");
      appliquees += 1;
      console.log("   ✅ appliqué");
    } catch (erreur) {
      await client.query("ROLLBACK").catch(() => {});
      // On remonte l'erreur au lieu de l'avaler : c'est l'appelant qui
      // décide quoi en faire — s'arrêter net pour le serveur, sortir en
      // code d'erreur pour `npm run migrate`.
      throw new Error(`${nom} — ${erreur.message}`);
    } finally {
      client.release();
    }
  }

  if (detaille || appliquees > 0) {
    console.log(
      appliquees === 0 ? "Base déjà à jour." : `✅ ${appliquees} migration(s) appliquée(s).`
    );
  }

  return appliquees;
}

/**
 * Applique les migrations en attente.
 *
 * Ne ferme pas le pool : le serveur s'en sert juste après. Lève une erreur
 * si une migration échoue.
 *
 * @param {object}  [options]
 * @param {boolean} [options.detaille] lister aussi les fichiers déjà appliqués
 * @returns {Promise<number>} nombre de migrations appliquées
 */
async function migrer({ detaille = true } = {}) {
  const verrou = await pool.connect();
  try {
    await verrou.query("SELECT pg_advisory_lock($1)", [CLE_VERROU]);
    return await appliquer(detaille);
  } finally {
    await verrou.query("SELECT pg_advisory_unlock($1)", [CLE_VERROU]).catch(() => {});
    verrou.release();
  }
}

// `npm run migrate` : on joue tout, on ferme le pool, et on sort en code
// d'erreur si quelque chose a échoué. Quand server.js importe ce fichier,
// rien ne se lance tout seul — c'est lui qui appelle migrer() au démarrage.
if (require.main === module) {
  migrer()
    .catch((erreur) => {
      console.error(`   ❌ ${erreur.message}`);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = { migrer };
