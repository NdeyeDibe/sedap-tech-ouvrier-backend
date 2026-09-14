const fs = require("fs");
const path = require("path");
const pool = require("./pool");

// Les fichiers .sql de ce dossier, joués dans l'ordre alphabétique.
// D'où la numérotation : 002_ passe après schema.sql, 003_ après 002_.
const DOSSIER = __dirname;

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

async function migrer() {
  await preparerJournal();
  const faites = await dejaAppliquees();
  const fichiers = fichiersSql();

  let appliquees = 0;

  for (const nom of fichiers) {
    if (faites.has(nom)) {
      console.log(`⏭  ${nom} — déjà appliqué`);
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
      await client.query(
        "INSERT INTO migrations_appliquees (nom) VALUES ($1)",
        [nom]
      );
      await client.query("COMMIT");
      appliquees += 1;
      console.log(`   ✅ appliqué`);
    } catch (erreur) {
      await client.query("ROLLBACK");
      console.error(`   ❌ ${erreur.message}`);
      client.release();
      await pool.end();
      process.exitCode = 1;
      return;
    }
    client.release();
  }

  console.log(
    appliquees === 0
      ? "Base déjà à jour."
      : `✅ ${appliquees} migration(s) appliquée(s).`
  );
  await pool.end();
}

migrer();
