-- classification: expand
BEGIN;

-- Suppression des matières libres (R12, lot 2 tâche 5) : seul le privilège manquait.
-- Aucune table ne référence encore `subjects` (devoirs et ressources au lot 3) : la règle
-- « matière utilisée » n'a donc rien à protéger ici ; son déclencheur et sa traduction
-- viendront avec les références, au lot 3.
GRANT DELETE ON app.subjects TO cp_app;

COMMIT;
