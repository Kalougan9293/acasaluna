# Nouveau restaurant (multi-tenant)

Ce dépôt sert **un restaurant par identifiant** (`resto` dans l’URL). Les fichiers vivent dans `menus/`.

## Règles pour le **slug** (`resto`)

- Uniquement : **lettres**, **chiffres**, **tiret** `-`, **underscore** `_`.
- Pas d’espaces ni d’accents dans le slug (l’URL reste simple).
- Exemples valides : `bistrot-martin`, `hotel_rivage`, `client3`.
- **Ne pas changer** le slug après le lancement : sinon nouvelles stats et nouveaux liens.

## Fichiers à créer pour un nouveau client

1. **Menu + config admin**  
   - Copier `templates/tenant-menu.example.json` vers `menus/<slug>.json`.  
   - Renseigner `config` : `nom_resto`, `admin_user`, `admin_pass` (uniques par client).  
   - Compléter `carte_des_plats` et `vins` (voir `menus/default.json` pour un exemple riche).

2. **Stats** (vide au départ)  
   - Copier `templates/tenant-stats.empty.json` vers `menus/<slug>.stats.json`.

3. **Redémarrer le serveur Node** après ajout ou remplacement de fichiers menu (cache mémoire des menus).

## URLs à communiquer

- **App client** : `…/app.html?resto=<slug>`  
- **Admin** : `…/admin.html?resto=<slug>` (connexion avec `admin_user` / `admin_pass` du `menus/<slug>.json`).

## Fichier `default`

- Sans `?resto=`, l’app utilise **`menus/default.json`** et **`default.stats.json`**.  
- Recommandation : réserver `default` à la **démo interne** ; les vrais clients ont toujours leur **slug** dédié.

## Check-list rapide

| Étape | Fait |
|--------|------|
| Slug choisi et stable | ☐ |
| `menus/<slug>.json` créé et rempli | ☐ |
| `menus/<slug>.stats.json` copié depuis le template vide | ☐ |
| Identifiants admin notés (coffre-fort) | ☐ |
| URLs app + admin testées | ☐ |
| Serveur redémarré si besoin | ☐ |

## À faire côté hébergement / toi

- Variable d’environnement **`ADMIN_SESSION_SECRET`** (ou équivalent) : une valeur secrète en production pour les sessions admin.
- Clé **Mistral** : une seule clé serveur pour tous les tenants (facturation globale).
- **Sauvegardes** régulières du dossier `menus/` (menus + stats + `*.menu_diff.json`).
