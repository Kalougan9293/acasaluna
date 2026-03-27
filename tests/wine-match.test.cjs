/**
 * Tests unitaires (sans serveur HTTP) pour wine-match.js
 * Lance : npm test
 */
const assert = require("assert");
const wm = require("../wine-match.js");

const miniMenu = {
    VinsRouges: [
        { nom: 'Châteauneuf-du-Pape "La Crau" - Domaine du Vieux Télégraphe', type: "Rouge" },
        { nom: "Morgon - Marcel Lapierre", type: "Rouge" }
    ],
    VinsBlancs: [{ nom: "Sancerre - Domaine Vacheron", type: "Blanc" }]
};

assert.strictEqual(wm.computeWineMatchScore("Morgon - Marcel Lapierre", "Morgon - Marcel Lapierre"), 1);
// Variante abrégée : doit rester au-dessus du seuil menu (0.76) pour être corrigée automatiquement
assert.ok(wm.computeWineMatchScore("Morgon - Marcel Lapierre", "Morgon - Marcel Lapierre") >= wm.MIN_WINE_MENU_MATCH_SCORE);

const ok1 = wm.tryFixSuggestionToMenu(
    `[SUGGESTION] : Morgon - Marcel Lapierre (Rouge)\n[EXPLICATION] : test`,
    miniMenu
);
assert.strictEqual(ok1.ok, true);
assert.ok(ok1.answer.includes("Morgon - Marcel Lapierre"));

const bad = wm.tryFixSuggestionToMenu(
    `[SUGGESTION] : Vin Inventé Totalement 12345 (Rouge)\n[EXPLICATION] : x`,
    miniMenu
);
assert.strictEqual(bad.ok, false);
assert.strictEqual(bad.reason, "no_match");

const noTag = wm.tryFixSuggestionToMenu("pas de suggestion ici", miniMenu);
assert.strictEqual(noTag.ok, false);
assert.strictEqual(noTag.reason, "no_suggestion");

console.log("wine-match.test.cjs : OK");
