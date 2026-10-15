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

Données : `~/.local/share/taskgnome` (base SQLite, journaux des runs). Logs du démon : `journalctl --user -u taskgnome -f`.

## Développement

Environnement : [devenv](https://devenv.sh) (`direnv allow`, ou `devenv shell`) — Node 24 et pnpm.

```sh
pnpm check        # tsc (configuration la plus stricte) + oxlint --type-aware
```

- TypeScript exécuté directement par Node (type stripping) : pas de build.
- Toutes les données externes (événements du serveur opencode, réponses du démon, lignes SQLite, journaux) sont validées avec zod.
- Règles oxlint désactivées volontairement (`.oxlintrc.json`) : `prefer-readonly-parameter-types` (inapplicable avec les types Node), `no-inline-comments` et les métriques de taille (style), `no-redeclare` (l'idiome zod `const X` + `type X`, déjà vérifié par TypeScript), `prefer-top-level-await` (faux positifs sur `.catch()` de zod), `no-await-in-loop` dans le mode interactif (menus séquentiels par nature).
- L'extension (`extension/`) est en JavaScript GJS, pas encore vérifiée (voir #4).

Le suivi du développement se fait dans les [issues](https://github.com/maarekj/task-gnome/issues).
