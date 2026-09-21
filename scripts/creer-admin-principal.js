// Crée le tout premier compte admin principal.
//
// Aucune route ne peut le faire : « + Ajouter un admin » est réservé à un
// admin principal déjà connecté (cahier admin XI.5), et il n'y a pas
// d'inscription publique. Ce compte-là naît donc à la main, une seule fois.
//
// En local :
//   node scripts/creer-admin-principal.js mengue@sedap.sn Mengué Diouf
// Sur Railway (depuis le dossier du projet, CLI Railway installée) :
//   railway run node scripts/creer-admin-principal.js mengue@sedap.sn Mengué Diouf
//
// Le mot de passe est demandé à la saisie (masqué), ou lu dans la variable
// MOT_DE_PASSE si elle est définie. Il n'apparaît jamais dans la commande :
// l'historique du terminal le garderait en clair.

const bcrypt = require("bcryptjs");
const readline = require("readline");
const pool = require("../src/db/pool");

const TOUR_DE_HACHAGE = 10;

// Même règle que l'écran de connexion (cahier admin III) : 8 caractères au
// minimum, une majuscule, un chiffre, un caractère spécial.
function motDePasseFaible(valeur) {
  if (!valeur || valeur.length < 8) return "8 caractères minimum.";
  if (!/[A-Z]/.test(valeur)) return "Il faut au moins une majuscule.";
  if (!/[0-9]/.test(valeur)) return "Il faut au moins un chiffre.";
  if (!/[^A-Za-z0-9]/.test(valeur)) return "Il faut au moins un caractère spécial.";
  return null;
}

// Saisie masquée : readline affiche normalement chaque touche tapée.
function demanderMasque(question) {
  return new Promise((resoudre) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const sortie = rl.output;
    let masquer = false;

    sortie.write(question);
    // Remplace l'écriture des caractères tapés par une étoile.
    rl._writeToOutput = (texte) => {
      if (!masquer) return sortie.write(texte);
      if (texte.includes("\n") || texte.includes("\r")) return sortie.write("\n");
      sortie.write("*");
    };
    masquer = true;

    rl.question("", (reponse) => {
      rl.close();
      resoudre(reponse);
    });
  });
}

async function creer() {
  const [email, prenom, nom] = process.argv.slice(2);

  if (!email || !email.includes("@")) {
    console.error("Usage : node scripts/creer-admin-principal.js <email> <prénom> <nom>");
    process.exitCode = 1;
    return;
  }

  // Un admin principal actif existe déjà : le second se crée depuis
  // l'interface, pour que sa création soit tracée (cree_par).
  const { rows: existants } = await pool.query(
    "SELECT email FROM admins WHERE role = 'admin_principal' AND actif LIMIT 1"
  );
  if (existants.length > 0) {
    console.error(
      `❌ Un admin principal existe déjà (${existants[0].email}). ` +
        "Créez les suivants depuis Paramètres → Administrateurs."
    );
    process.exitCode = 1;
    return;
  }

  const { rows: memeEmail } = await pool.query(
    "SELECT id FROM admins WHERE lower(email) = lower($1)",
    [email]
  );
  if (memeEmail.length > 0) {
    console.error("❌ Cette adresse e-mail a déjà un compte admin.");
    process.exitCode = 1;
    return;
  }

  let motDePasse = process.env.MOT_DE_PASSE;

  if (!motDePasse) {
    motDePasse = await demanderMasque("Mot de passe : ");
    const confirmation = await demanderMasque("Confirmer     : ");
    if (motDePasse !== confirmation) {
      console.error("❌ Les deux saisies sont différentes.");
      process.exitCode = 1;
      return;
    }
  }

  const probleme = motDePasseFaible(motDePasse);
  if (probleme) {
    console.error(`❌ Mot de passe refusé : ${probleme}`);
    process.exitCode = 1;
    return;
  }

  const hash = await bcrypt.hash(motDePasse, TOUR_DE_HACHAGE);

  const { rows } = await pool.query(
    `INSERT INTO admins (email, mot_de_passe_hash, prenom, nom, role)
     VALUES (lower($1), $2, $3, $4, 'admin_principal')
     RETURNING id, email, prenom, nom, role`,
    [email.trim(), hash, prenom || null, nom || null]
  );

  const admin = rows[0];
  console.log(
    `✅ Admin principal créé : ${admin.prenom ?? ""} ${admin.nom ?? ""} <${admin.email}> (id ${admin.id})`
  );
}

creer()
  .catch((erreur) => {
    console.error("❌ Échec :", erreur.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
