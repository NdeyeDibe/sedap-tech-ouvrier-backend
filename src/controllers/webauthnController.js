const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");
const pool = require("../db/pool");
const jwt = require("jsonwebtoken");

// RP_ID doit être EXACTEMENT le nom de domaine (sans https://, sans
// port) de l'adresse où tourne le FRONTEND — pas le backend. C'est le
// navigateur qui vérifie ça, pas nous : si ça ne correspond pas
// exactement à l'adresse affichée dans la barre du navigateur, Face ID
// refuse silencieusement. À mettre à jour dans les variables
// d'environnement le jour où un vrai nom de domaine remplace l'adresse
// Netlify temporaire.
const RP_ID = process.env.WEBAUTHN_RP_ID || "localhost";
const RP_NOM = "SEDAP'Tech";
const ORIGIN_ATTENDUE = process.env.WEBAUTHN_ORIGIN || `https://${RP_ID}`;

// Garde en mémoire les "défis" (challenges) le temps de la cérémonie
// WebAuthn (quelques secondes) — pas besoin de les stocker en base,
// une simple Map suffit et évite une table de plus. Clé = ouvrierId
// (inscription) ou téléphone (connexion).
const defisEnAttente = new Map();

// ÉTAPE 1 (inscription) : l'ouvrier est déjà connecté par PIN, et
// souhaite activer Face ID/empreinte pour la prochaine fois. On génère
// un défi cryptographique que son téléphone doit signer.
async function optionsInscription(req, res) {
  try {
    const ouvrierId = req.ouvrierId;
    const resultat = await pool.query("SELECT telephone, nom, prenom FROM ouvriers WHERE id = $1", [ouvrierId]);
    if (resultat.rows.length === 0) {
      return res.status(404).json({ erreur: "Ouvrier introuvable." });
    }
    const ouvrier = resultat.rows[0];

    const dejaEnregistres = await pool.query(
      "SELECT identifiant_credential FROM credentials_webauthn WHERE ouvrier_id = $1",
      [ouvrierId]
    );

    const options = await generateRegistrationOptions({
      rpName: RP_NOM,
      rpID: RP_ID,
      userID: Buffer.from(String(ouvrierId)),
      userName: ouvrier.telephone,
      userDisplayName: [ouvrier.prenom, ouvrier.nom].filter(Boolean).join(" ") || ouvrier.telephone,
      attestationType: "none", // on ne vérifie pas la marque du téléphone, juste que Face ID/empreinte a fonctionné
      excludeCredentials: dejaEnregistres.rows.map((c) => ({ id: c.identifiant_credential })),
      authenticatorSelection: {
        authenticatorAttachment: "platform", // Face ID/empreinte du téléphone lui-même, pas une clé USB externe
        userVerification: "required", // exige vraiment Face ID/empreinte, pas juste "le téléphone est déverrouillé"
      },
    });

    defisEnAttente.set(`inscription:${ouvrierId}`, options.challenge);
    res.json(options);
  } catch (erreur) {
    console.error("Erreur options inscription WebAuthn :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// ÉTAPE 2 (inscription) : le téléphone renvoie la réponse signée — on
// vérifie qu'elle correspond bien au défi envoyé, puis on enregistre la
// clé publique en base (jamais la biométrie elle-même, qui ne quitte
// jamais le téléphone).
async function verifierInscription(req, res) {
  try {
    const ouvrierId = req.ouvrierId;
    const challengeAttendu = defisEnAttente.get(`inscription:${ouvrierId}`);
    if (!challengeAttendu) {
      return res.status(400).json({ erreur: "Aucune demande d'inscription en cours. Réessaie depuis le début." });
    }

    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: challengeAttendu,
      expectedOrigin: ORIGIN_ATTENDUE,
      expectedRPID: RP_ID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ erreur: "Échec de la vérification. Réessaie." });
    }

    const { credential } = verification.registrationInfo;
    await pool.query(
      `INSERT INTO credentials_webauthn (ouvrier_id, identifiant_credential, cle_publique, compteur)
       VALUES ($1, $2, $3, $4)`,
      [ouvrierId, credential.id, Buffer.from(credential.publicKey).toString("base64url"), credential.counter]
    );

    defisEnAttente.delete(`inscription:${ouvrierId}`);
    res.status(201).json({ statut: "ok" });
  } catch (erreur) {
    console.error("Erreur vérification inscription WebAuthn :", erreur);
    res.status(500).json({ erreur: "Erreur serveur pendant l'activation." });
  }
}

// ÉTAPE 1 (connexion) : l'ouvrier tape son numéro sur l'écran de
// connexion et appuie sur "Face ID" — on cherche ses clés déjà
// enregistrées et on génère un nouveau défi.
async function optionsConnexion(req, res) {
  try {
    const { telephone } = req.body;
    const resultatOuvrier = await pool.query("SELECT id FROM ouvriers WHERE telephone = $1", [telephone]);
    if (resultatOuvrier.rows.length === 0) {
      return res.status(404).json({ erreur: "Numéro non reconnu." });
    }
    const ouvrierId = resultatOuvrier.rows[0].id;

    const credentials = await pool.query(
      "SELECT identifiant_credential FROM credentials_webauthn WHERE ouvrier_id = $1",
      [ouvrierId]
    );
    if (credentials.rows.length === 0) {
      return res.status(404).json({ erreur: "Face ID n'est pas activé pour ce compte. Utilise ton code PIN." });
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: "required",
      allowCredentials: credentials.rows.map((c) => ({ id: c.identifiant_credential })),
    });

    defisEnAttente.set(`connexion:${telephone}`, options.challenge);
    res.json(options);
  } catch (erreur) {
    console.error("Erreur options connexion WebAuthn :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

// ÉTAPE 2 (connexion) : vérifie la réponse Face ID/empreinte et
// renvoie un vrai token de connexion — exactement comme après un PIN
// correct (voir authController.connexion).
async function verifierConnexion(req, res) {
  try {
    const { telephone, reponse } = req.body;
    const challengeAttendu = defisEnAttente.get(`connexion:${telephone}`);
    if (!challengeAttendu) {
      return res.status(400).json({ erreur: "Session expirée. Réessaie." });
    }

    const resultatCredential = await pool.query(
      `SELECT cw.id, cw.identifiant_credential, cw.cle_publique, cw.compteur, o.id AS ouvrier_id, o.prenom, o.compte_verrouille
       FROM credentials_webauthn cw
       JOIN ouvriers o ON o.id = cw.ouvrier_id
       WHERE cw.identifiant_credential = $1 AND o.telephone = $2`,
      [reponse.id, telephone]
    );
    if (resultatCredential.rows.length === 0) {
      return res.status(404).json({ erreur: "Identifiant biométrique inconnu." });
    }
    const cred = resultatCredential.rows[0];

    if (cred.compte_verrouille) {
      return res.status(403).json({ erreur: "Compte verrouillé. Contactez le support SEDAP.", compteVerrouille: true });
    }

    const verification = await verifyAuthenticationResponse({
      response: reponse,
      expectedChallenge: challengeAttendu,
      expectedOrigin: ORIGIN_ATTENDUE,
      expectedRPID: RP_ID,
      credential: {
        id: cred.identifiant_credential,
        publicKey: Buffer.from(cred.cle_publique, "base64url"),
        counter: Number(cred.compteur),
      },
    });

    if (!verification.verified) {
      return res.status(401).json({ erreur: "Échec de la vérification Face ID." });
    }

    await pool.query("UPDATE credentials_webauthn SET compteur = $1 WHERE id = $2", [
      verification.authenticationInfo.newCounter,
      cred.id,
    ]);

    defisEnAttente.delete(`connexion:${telephone}`);
    const token = jwt.sign({ ouvrierId: cred.ouvrier_id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, ouvrierId: cred.ouvrier_id, prenom: cred.prenom });
  } catch (erreur) {
    console.error("Erreur vérification connexion WebAuthn :", erreur);
    res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = { optionsInscription, verifierInscription, optionsConnexion, verifierConnexion };