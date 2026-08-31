// Script de migration simple : exécute schema.sql contre la base
// configurée dans .env. Pas d'outil de migration complexe (Prisma,
// Knex...) pour l'instant — vu la taille du projet, un fichier SQL
// unique relu à chaque fois (CREATE TABLE IF NOT EXISTS partout) suffit
// et reste facile à comprendre/modifier à la main.
//
// Utilisation : npm run migrate
const fs = require("fs");
const path = require("path");
const pool = require("./pool");

async function migrer() {
  const cheminSchema = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(cheminSchema, "utf-8");

  console.log("Exécution de schema.sql...");
  try {
    await pool.query(sql);
    console.log("✅ Migration terminée avec succès.");
  } catch (erreur) {
    console.error("❌ Erreur pendant la migration :", erreur.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrer();