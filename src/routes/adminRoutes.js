const express = require("express");
const router = express.Router();
const {
  connexion,
  motDePasseOublie,
  reinitialiser,
  moi,
  modifierMoi,
  modifierMotDePasse,
} = require("../controllers/adminAuthController");
const { creerOuvrierResponsable } = require("../controllers/adminOuvriersController");
const {
  deverrouillerOuvrier,
  deverrouillerProprietaire,
  reinitialiserPinOuvrier,
} = require("../controllers/adminComptesController");
const {
  corrigerBande,
  corrigerSaisie,
  detailBandeAdmin,
  photosSaisieAdmin,
} = require("../controllers/adminBandesController");
const { corrigerVente, supprimerVente } = require("../controllers/adminVentesController");
const { corrigerReception } = require("../controllers/adminReceptionsController");
const {
  listeClients,
  creerClient,
  ficheClient,
  modifierClient,
  suspendreClient,
  reactiverClient,
  reinitialiserPinClient,
  renvoyerLien,
} = require("../controllers/adminClientsController");
const { tableauDeBord } = require("../controllers/adminTableauDeBordController");
const { listeAlertes, marquerAlerte } = require("../controllers/adminAlertesController");
const push = require("../controllers/adminPushController");
const programme = require("../controllers/adminProgrammeController");
const listes = require("../controllers/adminListesController");
const admins = require("../controllers/adminAdminsController");
const {
  lireSeuils,
  modifierSeuils,
  reinitialiserSeuils,
} = require("../controllers/adminSeuilsController");
const {
  rapportParFerme,
  rapportMensuel,
  rapportAnnuel,
} = require("../controllers/adminRapportsController");
const { detailFerme } = require("../controllers/adminFermesController");
const { exigerAdmin, exigerAdminPrincipal } = require("../middleware/exigerAdmin");

// Interface admin — cahier admin v1.1, annexe A.
// Toutes les routes commencent par /api/admin.

// ------------------------------------------------ authentification (libre)
router.post("/auth/connexion", connexion);
router.post("/auth/mot-de-passe-oublie", motDePasseOublie);
router.post("/auth/reinitialiser", reinitialiser);

// ------------------------------------------- tout ce qui suit : admin actif
router.use(exigerAdmin);

router.get("/auth/moi", moi);
router.patch("/auth/moi", modifierMoi);
router.patch("/auth/mot-de-passe", modifierMotDePasse);

// ---------------------------------------------------------- notifications
// Un abonnement push vaut pour UN appareil : l'admin les règle depuis
// chacun de ses appareils (maquette 19).
router.get("/push/cle", push.clePublique);
router.get("/push/etat", push.etat);
router.post("/push/abonner", push.abonner);
router.patch("/push/preferences", push.modifierPreferences);
router.delete("/push/abonner", push.desabonner);
router.post("/push/test", push.tester);

// ------------------------------------------------------- tableau de bord
router.get("/tableau-de-bord", tableauDeBord);

// ------------------------------------------------------ seuils d'alerte
// ★ Admin principal seulement : ces valeurs gouvernent les trois
// interfaces, un réglage malheureux éteint les alertes de toutes les
// fermes en même temps.
router.get("/seuils", lireSeuils);
router.patch("/seuils", exigerAdminPrincipal, modifierSeuils);
router.delete("/seuils", exigerAdminPrincipal, reinitialiserSeuils);

// --------------------------------------------------- programme sanitaire
// ★ Admin principal. Le programme est un MODÈLE : chaque bande en reçoit
// une copie à son démarrage, modifier ceci ne touche aucune bande en cours.
router.get("/programme", programme.lireProgramme);
router.post("/programme", exigerAdminPrincipal, programme.ajouterActe);
router.patch("/programme/:id", exigerAdminPrincipal, programme.modifierActe);
router.delete("/programme/:id", exigerAdminPrincipal, programme.supprimerActe);

// ------------------------------------------------ listes de référence
// Une valeur déjà utilisée se masque, elle ne se supprime pas : effacer un
// couvoir laisserait les bandes qui en viennent avec une provenance
// orpheline.
router.get("/listes", listes.lireListes);
router.post("/listes", exigerAdminPrincipal, listes.ajouterValeur);
router.patch("/listes/:id", exigerAdminPrincipal, listes.modifierValeur);
router.delete("/listes/:id", exigerAdminPrincipal, listes.supprimerValeur);

// ------------------------------------------------------ administrateurs
// ★ Admin principal. On ne désactive ni son propre compte, ni le dernier
// admin principal actif.
router.get("/administrateurs", admins.listeAdmins);
router.post("/administrateurs", exigerAdminPrincipal, admins.creerAdmin);
router.patch("/administrateurs/:id", exigerAdminPrincipal, admins.modifierAdmin);
router.patch("/administrateurs/:id/actif", exigerAdminPrincipal, admins.changerActivite);
router.post("/administrateurs/:id/renvoyer-lien", exigerAdminPrincipal, admins.renvoyerLien);

// -------------------------------------------------------------- alertes
// Les alertes se recalculent ; seul leur suivi se stocke (migration 021).
// « Traitée » et « Ignorée » ne changent que la liste de SEDAP : le
// propriétaire voit son alerte tant que la situation dure.
router.get("/alertes", listeAlertes);
router.patch("/alertes/suivi", marquerAlerte);

// --------------------------------------------------------------- clients
// SEDAP crée le propriétaire, sa ferme et ses poulaillers en une fois.
router.get("/clients", listeClients);
router.post("/clients", creerClient);

// La fiche d'un propriétaire, et tout ce qu'on peut y décider (maquettes
// 12 et 13). La suspension n'efface rien : elle ferme l'accès, au
// propriétaire comme aux ouvriers de sa ferme.
router.get("/clients/:id", ficheClient);
router.patch("/clients/:id", modifierClient);
router.patch("/clients/:id/suspendre", suspendreClient);
router.patch("/clients/:id/reactiver", reactiverClient);
router.post("/clients/:id/reinitialiser-pin", reinitialiserPinClient);
router.post("/clients/:id/renvoyer-lien", renvoyerLien);

// -------------------------------------------------------------- rapports
// Trois vues du même exercice : par ferme, par mois, par année. Les
// chiffres sortent de bilans_bandes et de utils/finances.js — ceux-là
// mêmes qui alimentent les bilans du propriétaire.
router.get("/rapports/par-ferme", rapportParFerme);
router.get("/rapports/mensuel", rapportMensuel);
router.get("/rapports/annuel", rapportAnnuel);

// ---------------------------------------------------------------- fermes
router.get("/fermes/:id", detailFerme);

// ------------------------------------------------ ouvriers responsables
// Remplace l'ancienne route publique /api/auth/pre-inscrire.
router.post("/poulaillers/:id/ouvrier", creerOuvrierResponsable);

// --------------------------------------------------------------- bandes
// Correction des chiffres saisis par l'ouvrier (reçus, morts à l'arrivée…).
router.get("/bandes/:id", detailBandeAdmin);
router.patch("/bandes/:id", corrigerBande);
// Rattrape une faute de frappe sur une journée déjà verrouillée.
router.patch("/bandes/:id/saisies/:date", corrigerSaisie);
// Les photos de mortalité et le vocal de santé d'une journée : SEDAP juge
// sur pièces avant de corriger un chiffre.
router.get("/bandes/:bandeId/saisies/:date/photos", photosSaisieAdmin);

// ---------------------------------------------------------------- ventes
// Une vente fausse déforme le bilan : SEDAP peut la corriger ou la retirer.
router.patch("/ventes/:id", corrigerVente);
router.delete("/ventes/:id", supprimerVente);

// ------------------------------------------------------------ réceptions
// Corriger une quantité reçue ajuste aussi le stock disponible.
router.patch("/receptions/:id", corrigerReception);

// ------------------------------------------------------ comptes bloqués
// Trois mauvais PIN et le compte se verrouille : SEDAP le rouvre d'ici.
router.patch("/ouvriers/:id/deverrouiller", deverrouillerOuvrier);
router.patch("/proprietaires/:id/deverrouiller", deverrouillerProprietaire);

// Code oublié, et non trois essais ratés : on efface le PIN, l'ouvrier en
// choisit un nouveau au prochain démarrage de l'appli.
router.post("/ouvriers/:id/reinitialiser-pin", reinitialiserPinOuvrier);

module.exports = router;
