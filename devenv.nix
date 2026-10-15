{ pkgs, ... }:

{
  # Node 24 : TypeScript exécuté nativement (type stripping) et node:sqlite intégré.
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    pnpm = {
      enable = true;
      install.enable = true;
    };
  };

  packages = [
    pkgs.glib # gdbus (notifications, ouverture des préférences)
    pkgs.gjs # tester les modules de l'extension hors de GNOME Shell
  ];

  enterShell = ''
    echo "taskgnome — pnpm check (types + lint), bin/taskgnome --help"
  '';

  enterTest = ''
    pnpm check
  '';
}
