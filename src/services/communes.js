// Communes du Sénégal, avec leurs coordonnées.
//
// Pourquoi une liste en dur plutôt qu'un service de géocodage : la ferme
// est enregistrée une fois, par SEDAP, avec un texte libre du genre
// « Keur Massar, Dakar ». Géocoder ce texte demanderait un service
// externe de plus, avec sa clé, ses quotas et ses erreurs — pour une
// poignée de fermes et une précision dont l'alerte chaleur n'a pas
// besoin : à l'échelle d'une commune, la température de demain ne varie
// pas de plus d'un degré.
//
// La liste couvre les 14 chefs-lieux de région et les communes où
// l'aviculture est répandue (Niayes, Petite Côte, bassin arachidier).
// Pour en ajouter une : le nom, la région, et les coordonnées du centre
// de la commune (Google Maps, clic droit « Plus d'infos sur cet
// endroit »).

const COMMUNES = [
  { nom: "Dakar", region: "Dakar", latitude: 14.6937, longitude: -17.4441 },
  { nom: "Guédiawaye", region: "Dakar", latitude: 14.7692, longitude: -17.4056 },
  { nom: "Keur Massar", region: "Dakar", latitude: 14.7797, longitude: -17.3156 },
  { nom: "Pikine", region: "Dakar", latitude: 14.7645, longitude: -17.3906 },
  { nom: "Rufisque", region: "Dakar", latitude: 14.7167, longitude: -17.2667 },
  { nom: "Bargny", region: "Dakar", latitude: 14.6947, longitude: -17.2264 },
  { nom: "Diamniadio", region: "Dakar", latitude: 14.7272, longitude: -17.1844 },
  { nom: "Sébikotane", region: "Dakar", latitude: 14.7442, longitude: -17.1361 },

  { nom: "Thiès", region: "Thiès", latitude: 14.7886, longitude: -16.9246 },
  { nom: "Mbour", region: "Thiès", latitude: 14.4228, longitude: -16.9644 },
  { nom: "Saly", region: "Thiès", latitude: 14.4406, longitude: -17.0089 },
  { nom: "Joal-Fadiouth", region: "Thiès", latitude: 14.1667, longitude: -16.8333 },
  { nom: "Tivaouane", region: "Thiès", latitude: 14.9508, longitude: -16.8158 },
  { nom: "Mboro", region: "Thiès", latitude: 15.1333, longitude: -16.8833 },
  { nom: "Pout", region: "Thiès", latitude: 14.7714, longitude: -17.0614 },
  { nom: "Khombole", region: "Thiès", latitude: 14.7667, longitude: -16.7 },
  { nom: "Notto Gouye Diama", region: "Thiès", latitude: 14.9833, longitude: -16.9833 },

  { nom: "Saint-Louis", region: "Saint-Louis", latitude: 16.0179, longitude: -16.4896 },
  { nom: "Richard-Toll", region: "Saint-Louis", latitude: 16.4625, longitude: -15.7008 },
  { nom: "Dagana", region: "Saint-Louis", latitude: 16.5167, longitude: -15.5 },
  { nom: "Louga", region: "Louga", latitude: 15.6186, longitude: -16.2244 },
  { nom: "Kébémer", region: "Louga", latitude: 15.3686, longitude: -16.4475 },
  { nom: "Linguère", region: "Louga", latitude: 15.3936, longitude: -15.1183 },

  { nom: "Diourbel", region: "Diourbel", latitude: 14.6553, longitude: -16.2314 },
  { nom: "Touba", region: "Diourbel", latitude: 14.8667, longitude: -15.8833 },
  { nom: "Mbacké", region: "Diourbel", latitude: 14.7906, longitude: -15.9086 },
  { nom: "Bambey", region: "Diourbel", latitude: 14.7, longitude: -16.4667 },

  { nom: "Fatick", region: "Fatick", latitude: 14.3344, longitude: -16.4111 },
  { nom: "Foundiougne", region: "Fatick", latitude: 14.1333, longitude: -16.4667 },
  { nom: "Gossas", region: "Fatick", latitude: 14.4906, longitude: -16.0656 },
  { nom: "Sokone", region: "Fatick", latitude: 13.8794, longitude: -16.3733 },

  { nom: "Kaolack", region: "Kaolack", latitude: 14.1825, longitude: -16.2533 },
  { nom: "Nioro du Rip", region: "Kaolack", latitude: 13.75, longitude: -15.8 },
  { nom: "Guinguinéo", region: "Kaolack", latitude: 14.2667, longitude: -15.95 },
  { nom: "Kaffrine", region: "Kaffrine", latitude: 14.1058, longitude: -15.5508 },

  { nom: "Ziguinchor", region: "Ziguinchor", latitude: 12.5833, longitude: -16.2719 },
  { nom: "Bignona", region: "Ziguinchor", latitude: 12.8103, longitude: -16.2264 },
  { nom: "Oussouye", region: "Ziguinchor", latitude: 12.485, longitude: -16.5469 },
  { nom: "Kolda", region: "Kolda", latitude: 12.8939, longitude: -14.9408 },
  { nom: "Vélingara", region: "Kolda", latitude: 13.1497, longitude: -14.1061 },
  { nom: "Sédhiou", region: "Sédhiou", latitude: 12.7081, longitude: -15.5569 },

  { nom: "Tambacounda", region: "Tambacounda", latitude: 13.7708, longitude: -13.6672 },
  { nom: "Bakel", region: "Tambacounda", latitude: 14.9, longitude: -12.4667 },
  { nom: "Kédougou", region: "Kédougou", latitude: 12.5556, longitude: -12.1808 },
  { nom: "Matam", region: "Matam", latitude: 15.6559, longitude: -13.2548 },
  { nom: "Ourossogui", region: "Matam", latitude: 15.6058, longitude: -13.3203 },
];

/** La liste complète, pour la liste déroulante de l'admin. */
function listerCommunes() {
  return COMMUNES.map(({ nom, region, latitude, longitude }) => ({
    nom,
    region,
    latitude,
    longitude,
  }));
}

/** Retrouve une commune par son nom exact (celui envoyé par l'admin). */
function trouverCommune(nom) {
  const cherche = String(nom ?? "").trim().toLowerCase();
  return COMMUNES.find((c) => c.nom.toLowerCase() === cherche) ?? null;
}

module.exports = { listerCommunes, trouverCommune };
