# taskgnome

Planifie des prompts [opencode](https://opencode.ai) à heures régulières (cron), suit leurs sessions et les intègre à GNOME : icône dans la barre, notifications cliquables, historique avec la discussion complète.

- **Démon** (service `systemd --user`) : planificateur cron avec rattrapage après veille / extinction, exécution via `opencode serve`, suivi des sessions en direct.
- **CLI** `taskgnome` : toutes les opérations, avec `--json` pour les scripts et les agents ; mode interactif sans argument.
- **Extension GNOME Shell** : état des tâches, derniers runs, fenêtre de gestion (Adwaita) avec la discussion mise en forme.

Les sessions créées sont titrées `[task] <nom>`. « Continuer » ouvre la session dans un terminal (`opencode attach`) : les messages envoyés depuis ce terminal deviennent des runs suivis (notifications comprises), même si le terminal est fermé.

## Prérequis

- GNOME Shell 48 à 50, Node.js ≥ 24, `opencode` dans le `PATH`
- optionnel : `direnv` (pour charger le `.envrc` du dossier d'une tâche)

## Installation

```sh
pnpm install
bin/taskgnome install   # ~/.local/bin/taskgnome, extension GNOME, service systemd --user
```

Sous Wayland, GNOME Shell ne charge une extension nouvelle ou modifiée qu'après une déconnexion. Pour tester sans fermer sa session : `dbus-run-session -- gnome-shell --devkit --wayland`.

Le démon tourne dans le gestionnaire systemd de l'utilisateur : pour qu'il continue sans aucune session ouverte, activer le *linger* (`loginctl enable-linger`, ou `users.users.<nom>.linger = true;` sous NixOS).

## Utilisation

```sh
taskgnome                       # mode interactif
taskgnome add --name revue --cron "0 9 * * 1-5" --dir ~/projets/x --prompt "…" [--direnv] [--env KEY=VAL]
taskgnome list | history [--failed] | logs <run> | run <task> | resume <run> | status
taskgnome --help                # et `taskgnome <commande> --help`
```

Terminal utilisé par « Continuer » : `taskgnome terminal [--set <nom> | --auto]` ou les préférences (Réglages) ; enregistré dans `~/.config/taskgnome/config.json`.

Données : `~/.local/share/taskgnome` (base SQLite, journaux des runs). Logs du démon : `journalctl --user -u taskgnome -f`.

## Développement

Environnement : [devenv](https://devenv.sh) (`direnv allow`, ou `devenv shell`) — Node 24 et pnpm.

```sh
pnpm check        # tsc (configuration la plus stricte) + oxlint --type-aware + tests
pnpm test         # tests seuls (node:test)
```

- Tests (`test/`, `node:test`) : unitaires (planificateur, classement des erreurs, Markdown, journaux), intégration du runner contre un faux `opencode serve` (`test/fake-opencode`), et la CLI lancée réellement avec ses sorties `--json` validées contre le contrat de l'extension. Lancés par la CI GitHub à chaque push.
- TypeScript exécuté directement par Node (type stripping) : pas de build.
- Toutes les données externes (événements du serveur opencode, réponses du démon, lignes SQLite, journaux) sont validées avec zod.
- Règles oxlint désactivées volontairement (`.oxlintrc.json`) : `no-underscore-dangle` pour `_promisify` (API GJS), les imports sans nom de `extension/src/env.d.ts` (types globaux GJS), `no-deprecated` sur `Adw.PreferencesWindow` (imposée par GNOME Shell), et `prefer-readonly-parameter-types` (inapplicable avec les types Node), `no-inline-comments` et les métriques de taille (style), `no-redeclare` (l'idiome zod `const X` + `type X`, déjà vérifié par TypeScript), `prefer-top-level-await` (faux positifs sur `.catch()` de zod), `no-await-in-loop` dans le mode interactif (menus séquentiels par nature).
- L'extension (`extension/src`) est en TSX avec [gnim](https://aylur.github.io/gnim/) (JSX et réactivité pour GJS — attention, ce n'est pas React : un composant s'exécute une fois, seules les valeurs liées se mettent à jour). Trois contextes TypeScript : `shell` (GNOME Shell, `gnim/gnome`), `prefs` (Gtk 4 / Adwaita, `gnim/gtk4`) et `common`.
- `pnpm build:extension` produit `extension/dist` (esbuild) ; `taskgnome install` le fait aussi et y fait pointer GNOME Shell.
- gnim est publié en sources TypeScript qui ne passent pas la vérification avec les types `@girs` actuels : `scripts/gnim-types.ts` génère ses déclarations (`extension/types`, lancé par `pnpm typecheck`) et l'extension est vérifiée contre elles. Toutes les dépendances `@girs` sont alignées sur une seule version (`overrides` dans `pnpm-workspace.yaml`).
- Le format JSON échangé entre la CLI et l'extension est défini une seule fois dans `src/shared/api.ts` (zod/mini) : vérifié à la compilation côté CLI, validé à l'exécution côté extension.

Le suivi du développement se fait dans les [issues](https://github.com/maarekj/task-gnome/issues).
