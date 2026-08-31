// Connexion à PostgreSQL — un seul "pool" partagé par toute l'app,
// réutilisé par tous les contrôleurs (pas besoin d'ouvrir/fermer une
// connexion à chaque requête, le pool gère ça efficacement.
const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Petit log utile pour confirmer que la connexion fonctionne au
// démarrage du serveur (voir src/server.js)
pool.on("error", (err) => {
  console.error("Erreur inattendue sur le pool PostgreSQL :", err);
});

module.exports = pool;