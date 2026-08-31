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
