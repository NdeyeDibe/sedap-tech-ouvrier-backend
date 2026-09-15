-- Adresse du message vocal de l'ouvrier.
--
-- Jusqu'ici, saisies_sante ne gardait qu'un booléen a_vocal : la base savait
-- qu'un vocal existait, jamais où le trouver. Le fichier restait sur le
-- téléphone de l'ouvrier, derrière une adresse temporaire du navigateur,
-- effacée à la fermeture de l'onglet.
--
-- Le propriétaire voyait donc « un message vocal a été enregistré » sans
-- jamais pouvoir l'écouter — alors que c'est justement ce qui lui dirait ce
-- qui se passe dans son poulailler. Les photos, elles, partaient déjà sur
-- Cloudinary et avaient leur adresse.
--
-- a_vocal est conservé : les saisies déjà enregistrées n'ont pas d'adresse,
-- et l'écran doit pouvoir distinguer « pas de vocal » de « vocal d'avant,
-- irrécupérable ».

BEGIN;

ALTER TABLE saisies_sante
  ADD COLUMN IF NOT EXISTS vocal_url TEXT;

COMMIT;
