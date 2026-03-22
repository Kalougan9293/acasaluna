// CORRECTION : Try/catch pour éviter le crash dotenv sur Render
try { require('dotenv').config(); } catch (e) { console.log("Mode Production"); }

const { Mistral } = require('@mistralai/mistralai');
const rateLimit = require("express-rate-limit");
const http = require("http");
const fs = require("fs");
const path = require("path");
const {
    normalizeVinName,
    computeWineMatchScore,
    tryFixSuggestionToMenu,
    correctionPromptForInvalidWine
} = require("./wine-match.js");

const PUBLIC_DIR = path.resolve(path.join(__dirname, "public"));
const HAS_MISTRAL_KEY = !!(process.env.MISTRAL_API_KEY && process.env.MISTRAL_API_KEY.trim());

if (!HAS_MISTRAL_KEY) {
    console.warn("⚠️ MISTRAL_API_KEY manquante : /ask renverra 503.");
}

const MENUS_DIR = path.resolve(path.join(__dirname, "menus"));
const DEFAULT_MENU_PATH = path.join(MENUS_DIR, "default.json");
// Stats multi-tenants : un fichier par resto, stocké dans `menus/`.
// Ex : menus/client1.stats.json, menus/default.stats.json
const STATS_CACHE = new Map();

const MENU_CACHE = new Map();

function sanitizeRestoId(restoId) {
    const s = (restoId || "").toString().trim();
    if (!s) return "";
    // Anti path traversal: uniquement des caractères sûrs
    if (!/^[a-zA-Z0-9_-]+$/.test(s)) return "";
    return s;
}

function readJsonSafe(filePath) {
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

function getMenuDiffFilePath(restoId) {
    const safeResto = sanitizeRestoId(restoId);
    const fileName = safeResto ? `${safeResto}.menu_diff.json` : "default.menu_diff.json";
    return path.join(MENUS_DIR, fileName);
}

function normPlatNomForDiff(it) {
    if (typeof it === "string") return it.trim();
    if (it && typeof it === "object") return String(it.nom || it.name || "").trim();
    return "";
}

function platsNameMapForDiff(carte_des_plats) {
    const out = {};
    for (const c of ["Entrées", "Plats", "Desserts"]) {
        const arr = carte_des_plats && Array.isArray(carte_des_plats[c]) ? carte_des_plats[c] : [];
        out[c] = arr.map(normPlatNomForDiff).filter(Boolean);
    }
    return out;
}

function diffPlatsCarte(oldCarte, newCarte) {
    const o = platsNameMapForDiff(oldCarte || {});
    const n = platsNameMapForDiff(newCarte || {});
    const added = [];
    const removed = [];
    for (const c of ["Entrées", "Plats", "Desserts"]) {
        const os = new Set(o[c] || []);
        const ns = new Set(n[c] || []);
        for (const x of ns) if (!os.has(x)) added.push({ categorie: c, nom: x });
        for (const x of os) if (!ns.has(x)) removed.push({ categorie: c, nom: x });
    }
    return { added, removed };
}

function winesFlatFromVinsArray(vins) {
    if (!Array.isArray(vins)) return [];
    return vins
        .map(w => ({
            categorie: w && w.categorie ? String(w.categorie).trim() : "",
            nom: w && (w.nom || w.name) ? String(w.nom || w.name).trim() : ""
        }))
        .filter(w => w.nom);
}

function winesFlatFromCarteVins(carte_des_vins) {
    const list = [];
    Object.entries(carte_des_vins || {}).forEach(([cat, wines]) => {
        if (!Array.isArray(wines)) return;
        wines.forEach(w => {
            const nom = w && (w.nom || w.name) ? String(w.nom || w.name).trim() : "";
            if (!nom) return;
            list.push({ categorie: cat, nom });
        });
    });
    return list;
}

function wineIdentityForDiff(w) {
    return `${String(w.categorie || "").trim()}::${String(w.nom || "").trim()}`;
}

function diffWinesLists(oldList, newList) {
    const om = new Map(oldList.map(w => [wineIdentityForDiff(w), w]));
    const nm = new Map(newList.map(w => [wineIdentityForDiff(w), w]));
    const added = [];
    const removed = [];
    for (const [k, w] of nm) if (!om.has(k)) added.push(w);
    for (const [k, w] of om) if (!nm.has(k)) removed.push(w);
    return { added, removed };
}

function writeMenuDiffAfterSave(restoId, existingTenant, incomingData) {
    try {
        const platsDiff = diffPlatsCarte(existingTenant && existingTenant.carte_des_plats, incomingData && incomingData.carte_des_plats);
        let oldWines = winesFlatFromVinsArray(existingTenant && existingTenant.vins);
        if (!oldWines.length && existingTenant && existingTenant.carte_des_vins) {
            oldWines = winesFlatFromCarteVins(existingTenant.carte_des_vins);
        }
        const newWines = winesFlatFromCarteVins(incomingData && incomingData.carte_des_vins);
        const vinsDiff = diffWinesLists(oldWines, newWines);
        writeJsonSafe(getMenuDiffFilePath(restoId), {
            ts: new Date().toISOString(),
            plats: platsDiff,
            vins: vinsDiff
        });
    } catch (e) {
        console.error("writeMenuDiffAfterSave:", e);
    }
}

function readMenuDiffForResto(restoId) {
    const p = getMenuDiffFilePath(restoId);
    const d = readJsonSafe(p);
    if (!d || typeof d !== "object" || !d.ts) return null;
    return d;
}

function normalizeStatsRange(range) {
    const r = (range || "last30").toLowerCase();
    if (r === "last7" || r === "7" || r === "7d") return "last7";
    if (r === "all" || r === "depuis" || r === "all_time") return "all";
    return "last30";
}

function filterLogsByRange(arr, range) {
    if (!Array.isArray(arr)) return [];
    const nr = normalizeStatsRange(range);
    if (nr === "all") return arr.slice();
    const end = new Date();
    const endDayUtc = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), 0, 0, 0, 0));
    const startDayUtc = new Date(endDayUtc);
    if (nr === "last7") {
        startDayUtc.setUTCDate(endDayUtc.getUTCDate() - 6);
    } else {
        startDayUtc.setUTCDate(endDayUtc.getUTCDate() - 29);
    }
    const startTs = startDayUtc.getTime();
    return arr.filter(it => {
        if (!it || !it.ts) return false;
        const t = Date.parse(it.ts);
        return !Number.isNaN(t) && t >= startTs;
    });
}

/**
 * Clé pour « Top demandes » (erreurs) : même logique que le mouchard (question affichée).
 * Anciennes entrées ou cas limites peuvent n'avoir ni `question` ni texte utile : on retombe sur `message`.
 */
function getErrorLogQuestionKeyForTop(it) {
    if (!it || typeof it !== "object") return "";
    const q = String(it.question || it.demande || it.q || "").trim();
    if (q) return q;
    const msg = String(it.message || "").trim();
    if (msg) return msg.length > 140 ? `${msg.slice(0, 137)}...` : msg;
    return "(Sans détail)";
}

/** Lundi = 0 … Dimanche = 6 (UTC) */
function utcTimestampToFrenchWeekdayIndex(tsMs) {
    const d = new Date(tsMs);
    const wd = d.getUTCDay();
    return (wd + 6) % 7;
}

function computeWeekdayCountsFromLogs(logs) {
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (const it of logs) {
        if (!it || !it.ts) continue;
        const t = Date.parse(it.ts);
        if (Number.isNaN(t)) continue;
        counts[utcTimestampToFrenchWeekdayIndex(t)]++;
    }
    return counts;
}

/** Compte les demandes par mois (YYYY-MM), sur tout l’historique des logs fusionnés. */
function computeMonthlyCountsFromLogs(live, errors, maxMonths = 24) {
    const map = {};
    const merge = [...(Array.isArray(live) ? live : []), ...(Array.isArray(errors) ? errors : [])];
    for (const it of merge) {
        if (!it || !it.ts) continue;
        const t = Date.parse(it.ts);
        if (Number.isNaN(t)) continue;
        const d = new Date(t);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        map[key] = (map[key] || 0) + 1;
    }
    const keys = Object.keys(map).sort();
    const sliced = maxMonths > 0 && keys.length > maxMonths ? keys.slice(-maxMonths) : keys;
    return sliced.map((month) => ({ month, count: map[month] || 0 }));
}

function writeJsonSafe(filePath, obj) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
        return true;
    } catch (e) {
        return false;
    }
}

function getStatsFilePath(restoId) {
    const safeResto = sanitizeRestoId(restoId);
    const fileName = safeResto ? `${safeResto}.stats.json` : "default.stats.json";
    return path.join(MENUS_DIR, fileName);
}

function defaultTypeCounts() {
    return { Rouge: 0, Blanc: 0, "Rosé": 0, ChampagneBulles: 0, Spiritueux: 0, Autres: 0 };
}

/** Fusionne les anciens fichiers stats (Autre, etc.) vers le schéma à 6 familles. */
function mergeTypeCountsFromDisk(raw) {
    const o = defaultTypeCounts();
    if (!raw || typeof raw !== "object") return o;
    o.Rouge += Number(raw.Rouge || 0);
    o.Blanc += Number(raw.Blanc || 0);
    o["Rosé"] += Number(raw["Rosé"] || 0);
    o.ChampagneBulles += Number(raw.ChampagneBulles || 0);
    o.Spiritueux += Number(raw.Spiritueux || 0);
    o.Autres += Number(raw.Autres || 0);
    // Ancien bucket unique « Autre » (champagne mélangé, etc.) → Autres
    o.Autres += Number(raw.Autre || 0);
    return o;
}

function loadStatsForResto(restoId) {
    const statsFilePath = getStatsFilePath(restoId);
    if (STATS_CACHE.has(statsFilePath)) return STATS_CACHE.get(statsFilePath);

    const d = readJsonSafe(statsFilePath);
    const defaultInteraction = { flash: 0, texte_libre: 0, ouvrir_carte: 0, carte_vins: 0 };
    const rawIc = d && d.interaction_counts && typeof d.interaction_counts === "object" ? d.interaction_counts : {};
    const interaction_counts = { ...defaultInteraction, ...rawIc };

    const stats = {
        chiffre_affaires_euros: d && typeof d.chiffre_affaires_euros === "number" ? d.chiffre_affaires_euros : 0,
        keyword_counts: d && d.keyword_counts && typeof d.keyword_counts === "object" ? d.keyword_counts : {},
        suggestion_counts: d && d.suggestion_counts && typeof d.suggestion_counts === "object" ? d.suggestion_counts : {},
        error_reason_counts: d && d.error_reason_counts && typeof d.error_reason_counts === "object" ? d.error_reason_counts : {},
        type_counts: mergeTypeCountsFromDisk(d && d.type_counts),
        interaction_counts,
        live_log: d && Array.isArray(d.live_log) ? d.live_log.slice(0, 100) : [],
        error_log: d && Array.isArray(d.error_log) ? d.error_log.slice(0, 100) : [],
        daily_clients: d && d.daily_clients && typeof d.daily_clients === "object" ? d.daily_clients : {},
        daily_ca: d && d.daily_ca && typeof d.daily_ca === "object" ? d.daily_ca : {},
        last_updated: d && d.last_updated ? d.last_updated : null
    };

    STATS_CACHE.set(statsFilePath, stats);
    return stats;
}

function saveStatsForResto(restoId) {
    const statsFilePath = getStatsFilePath(restoId);
    const stats = loadStatsForResto(restoId);
    stats.last_updated = new Date().toISOString();
    writeJsonSafe(statsFilePath, stats);
    STATS_CACHE.delete(statsFilePath);
}

function getDayKey(d = new Date()) {
    // Buckets journaliers : clé simple et stable (UTC)
    return d.toISOString().slice(0, 10);
}

function parsePrixEuros(prixStr) {
    if (prixStr == null || prixStr === "") return 0;
    const s = String(prixStr).replace(/\s/g, "").replace(",", ".");
    const m = s.match(/(\d+(?:\.\d+)?)/);
    if (!m) return 0;
    return Math.round(parseFloat(m[1]) * 100) / 100;
}

function normalizeTypeForStats(type) {
    const t = normalizeVinName(type || "");

    // Spiritueux (avant rouge/blanc pour éviter ambiguïtés rares)
    if (
        /\b(whisky|whiskey|bourbon|scotch)\b/.test(t) ||
        t.includes("cognac") ||
        t.includes("armagnac") ||
        t.includes("rhum") ||
        t.includes("rum") ||
        t.includes("gin") ||
        t.includes("vodka") ||
        t.includes("tequila") ||
        t.includes("mezcal") ||
        t.includes("calvados") ||
        t.includes("porto") ||
        t.includes("liqueur") ||
        t.includes("spiritueux") ||
        t.includes("digestif") ||
        t.includes("eau de vie")
    ) {
        return "Spiritueux";
    }

    // Champagnes & bulles
    if (
        t.includes("champagne") ||
        t.includes("cremant") ||
        t.includes("mousseux") ||
        t.includes("effervescent") ||
        t.includes("petillant") ||
        t.includes("prosecco") ||
        t.includes("cava") ||
        t.includes("bulles") ||
        t.includes("sparkling")
    ) {
        return "ChampagneBulles";
    }

    if (t.includes("rouge")) return "Rouge";
    if (t.includes("blanc")) return "Blanc";
    if (t.includes("rose")) return "Rosé";
    if (t.includes("autre")) return "Autres";
    return "Autres";
}

function findWinePriceInMenu(carte_des_vins, suggestedName) {
    const target = normalizeVinName(suggestedName);
    if (!target) return 0;
    const cats = carte_des_vins && typeof carte_des_vins === "object" ? carte_des_vins : {};
    let bestScore = 0;
    let bestPrice = 0;
    for (const wines of Object.values(cats)) {
        if (!Array.isArray(wines)) continue;
        for (const w of wines) {
            const nom = w && (w.nom || w.name);
            if (!nom) continue;
            const score = computeWineMatchScore(suggestedName, nom);
            if (score > bestScore) {
                bestScore = score;
                bestPrice = parsePrixEuros(w.prix_bouteille || w.prixBouteille || w.prix || w.price || w.prix_verre || w.prixVerre);
            }
        }
    }
    return bestScore >= 0.55 ? bestPrice : 0;
}

function recordSearchKeywords(question, restoId) {
    if (!question || typeof question !== "string") return;
    const statsData = loadStatsForResto(restoId);
    const words = question.toLowerCase().replace(/[^a-zàâäéèêëïîôùûçœæ0-9'\-\s]/gi, " ").split(/\s+/).filter(w => w.length > 2);
    const seen = new Set();
    words.forEach(w => {
        if (seen.has(w)) return;
        seen.add(w);
        statsData.keyword_counts[w] = (statsData.keyword_counts[w] || 0) + 1;
    });
}

function isVagueWineName(name) {
    const n = normalizeVinName(name);
    if (!n) return true;
    const tokens = n.split(" ").filter(Boolean);
    const genericNames = new Set([
        "beaujolais", "bordeaux", "bourgogne", "chablis", "sancerre", "chardonnay",
        "merlot", "cabernet", "pinot", "rioja", "chianti", "rose", "rouge", "blanc", "vin"
    ]);
    if (tokens.length <= 2 && tokens.every(t => genericNames.has(t))) return true;
    return false;
}

function hasDomainAndYear(name) {
    const n = normalizeVinName(name);
    const hasYear = /\b(19|20)\d{2}\b/.test(n);
    const tokens = n.split(" ").filter(Boolean);
    const hasDomainHint = n.includes("domaine") || n.includes("chateau") || n.includes("clos") || n.includes("cuvee");
    return hasYear || (hasDomainHint && tokens.length >= 3);
}

function buildMenuSearchBlobNorm(tenantMenu) {
    const cats = tenantMenu && tenantMenu.carte_des_vins ? tenantMenu.carte_des_vins : {};
    const parts = [];
    for (const wines of Object.values(cats)) {
        if (!Array.isArray(wines)) continue;
        for (const w of wines) {
            if (!w) continue;
            parts.push(w.nom || "");
            parts.push(w.domaine || "");
            parts.push(w.type || "");
        }
    }
    return normalizeVinName(parts.join(" "));
}

function strictRefusalIfNeeded(question, tenantMenu) {
    const q = String(question || "");
    const qLower = q.toLowerCase();

    const menuBlob = buildMenuSearchBlobNorm(tenantMenu);

    // Refus strict uniquement pour demandes vraiment impossibles (et pas pour les mots présents dans les plats)

    // Grossesse / alcool / mineur : refus de conseiller de l'alcool
    const hasAlcoholRequest = /\bvin\b|\balcool\b|\bboire\b|\bverre\b|\bbouteille\b/i.test(qLower);
    const isPregnant = /\benceinte\b|\bgrossesse\b/.test(qLower);
    if (hasAlcoholRequest && isPregnant) {
        return "[STOP] Désolé, je ne peux pas conseiller de vin ou d'alcool pendant la grossesse. Je peux plutôt vous proposer une alternative sans alcool.";
    }
    // Détection simple du "X ans" si X < 18
    const ageMatch = qLower.match(/\b(\d{1,2})\s*ans?\b/);
    if (hasAlcoholRequest) {
        const age = ageMatch ? parseInt(ageMatch[1], 10) : null;
        if (age !== null && !Number.isNaN(age) && age < 18) {
            return "[STOP] Désolé, je ne peux pas conseiller d'alcool pour un mineur. Je peux aider avec une alternative sans alcool.";
        }
        if (/\bmineur\b/.test(qLower)) {
            return "[STOP] Désolé, je ne peux pas conseiller d'alcool pour un mineur. Je peux aider avec une alternative sans alcool.";
        }
    }

    // 1) Nonsense / personnage
    if (/\bbatman\b/i.test(qLower)) {
        return "[STOP] Désolé, je suis là uniquement pour vous conseiller le vin parfait.";
    }

    // 2) Contradiction "sec" vs "moelleux/doux/liquoreux" (uniquement si le texte parle bien de vin)
    const hasVinWord = /\bvin\b/i.test(qLower);
    const hasSec = /\bsec\b/.test(qLower) || /\bdry\b/.test(qLower);
    const hasMoelleux = /(moelleux|doux|liquoreux|sucr(e|é)|moelleuse)/i.test(qLower);
    if (hasVinWord && hasSec && hasMoelleux) {
        return "[STOP] Désolé, votre demande est contradictoire (sec + moelleux/doux).";
    }

    // 3) Profils "citron/coca" : éviter les faux positifs causés par un plat (ex: "Tarte au citron").
    // On refuse seulement si le goût est explicitement demandé pour le VIN (goût/saveur/profil + citron/coca),
    // et si aucun indice correspondant n'existe dans le menu.
    const wantsCitronWine = /(go[uû]t|saveur|ar[oô]me|profil).{0,25}citron|citron.{0,25}(go[uû]t|saveur|ar[oô]me|profil)/i.test(qLower);
    const wantsCocaWine = /(go[uû]t|saveur|ar[oô]me|profil).{0,25}coca|coca.{0,25}(go[uû]t|saveur|ar[oô]me|profil)/i.test(qLower);
    const wantsColaWine = /(go[uû]t|saveur|ar[oô]me|profil).{0,25}cola|cola.{0,25}(go[uû]t|saveur|ar[oô]me|profil)/i.test(qLower);
    if (hasVinWord && (wantsCitronWine || wantsCocaWine || wantsColaWine)) {
        const needs = [];
        if (wantsCitronWine) needs.push("citron");
        if (wantsCocaWine) needs.push("coca");
        if (wantsColaWine) needs.push("cola");

        const ok = needs.some(n => {
            const needle = normalizeVinName(n);
            return needle && menuBlob.includes(needle);
        });

        if (!ok) return "[STOP] Désolé, votre demande est trop spécifique pour notre carte.";
    }

    return null;
}

function validateMenuPayload(data) {
    const errors = [];
    const warnings = [];
    if (!data || !data.carte_des_plats || !data.carte_des_vins) {
        errors.push("carte_des_plats et carte_des_vins requis");
        return { ok: false, errors, warnings };
    }

    const seen = new Set();
    const allowed = new Set(["Rouge", "Blanc", "Rosé", "Autre"]);
    const priceDigitsRegex = /^\d+(?:[.,]\d+)?$/;
    Object.entries(data.carte_des_vins || {}).forEach(([categorie, wines]) => {
        if (!Array.isArray(wines)) return;
        wines.forEach((w, i) => {
            const nom = (w && (w.nom || w.name || "") || "").trim();
            const typeRaw = (w && (w.type || "") || "").trim();
            const normalizedType = normalizeTypeForStats(typeRaw);
            const type = typeRaw || "";
            if (!nom) {
                errors.push(`Nom de vin manquant (${categorie} #${i + 1})`);
                return;
            }
            const normalizedRawType = normalizeVinName(type);
            const isKnownOther =
                normalizedRawType.includes("autre") ||
                normalizedRawType.includes("petillant") ||
                normalizedRawType.includes("champagne") ||
                normalizedRawType.includes("effervescent");
            const typeOk =
                allowed.has(type) ||
                normalizedType !== "Autres" ||
                (normalizedType === "Autres" && isKnownOther);
            if (!type || !typeOk) {
                errors.push(`Type manquant ou incohérent pour "${nom}"`);
            }
            const key = `${normalizeVinName(nom)}|${normalizedType}`;
            if (seen.has(key)) errors.push(`Doublon détecté pour "${nom}" (${normalizedType})`);
            seen.add(key);

            if (isVagueWineName(nom)) {
                errors.push(`Vin trop vague : "${nom}"`);
            }
            if (!hasDomainAndYear(nom)) {
                warnings.push(`Fortement conseillé: préciser domaine et/ou année pour "${nom}"`);
            }

            const prixBouteille = (w && (w.prix_bouteille ?? w.prixBouteille ?? "")) ?? "";
            const prixVerre = (w && (w.prix_verre ?? w.prixVerre ?? "")) ?? "";
            const prixBouteilleStr = String(prixBouteille).trim();
            const prixVerreStr = String(prixVerre).trim();
            if (prixBouteilleStr && !priceDigitsRegex.test(prixBouteilleStr)) {
                errors.push(`Prix de la bouteille invalide (chiffres uniquement) pour "${nom}"`);
            }
            if (prixVerreStr && !priceDigitsRegex.test(prixVerreStr)) {
                errors.push(`Prix du verre invalide (chiffres uniquement) pour "${nom}"`);
            }
        });
    });
    return { ok: errors.length === 0, errors, warnings };
}

function buildMenuResponseFromTenantJson(tenantJson) {
    const config = tenantJson && tenantJson.config ? tenantJson.config : {};
    const carte_des_plats = tenantJson && tenantJson.carte_des_plats ? tenantJson.carte_des_plats : {};

    const carte_des_vins = {};
    if (tenantJson && Array.isArray(tenantJson.vins)) {
        tenantJson.vins.forEach(w => {
            const categorie = w && w.categorie ? w.categorie : "";
            if (!categorie) return;
            if (!carte_des_vins[categorie]) carte_des_vins[categorie] = [];
            carte_des_vins[categorie].push({
                nom: w.nom || "",
                domaine: w.domaine || "",
                annee: w.annee || "",
                prix_bouteille: w.prix_bouteille || w.prixBouteille || "",
                prix_verre: w.prix_verre || w.prixVerre || "",
                prix: w.prix || w.prix_bouteille || w.prixBouteille || w.prix_verre || w.prixVerre || "",
                type: w.type || "",
                pousser: !!w.pousser
            });
        });
    }

    return { config, carte_des_plats, carte_des_vins };
}

function normalizePlatsForAi(platsObj) {
    const out = {};
    const src = platsObj && typeof platsObj === "object" ? platsObj : {};
    for (const [cat, items] of Object.entries(src)) {
        if (!Array.isArray(items)) continue;
        out[cat] = items
            .map(it => {
                if (typeof it === "string") return { nom: it, info: "" };
                if (!it || typeof it !== "object") return null;
                const nom = (it.nom || it.name || "").toString();
                const info = (it.info || it.description || "").toString();
                if (!nom.trim()) return null;
                return { nom: nom.trim(), info: info.trim() };
            })
            .filter(Boolean);
    }
    return out;
}

function flattenPlatsForClient(aiPlatsObj) {
    const out = {};
    const src = aiPlatsObj && typeof aiPlatsObj === "object" ? aiPlatsObj : {};
    for (const [cat, items] of Object.entries(src)) {
        if (!Array.isArray(items)) continue;
        out[cat] = items
            .map(it => (it && typeof it === "object" ? it.nom : String(it || "")))
            .map(s => (s || "").trim())
            .filter(Boolean);
    }
    return out;
}

function getMenuForResto(restoId, mode = "ai") {
    const safeResto = sanitizeRestoId(restoId);
    const targetPath = safeResto ? path.join(MENUS_DIR, `${safeResto}.json`) : DEFAULT_MENU_PATH;
    const finalPath = safeResto && fs.existsSync(targetPath) ? targetPath : DEFAULT_MENU_PATH;

    const cacheKey = `${finalPath}::${mode}`;
    if (MENU_CACHE.has(cacheKey)) return MENU_CACHE.get(cacheKey);

    const tenantJson = readJsonSafe(finalPath) || readJsonSafe(DEFAULT_MENU_PATH) || {};
    const menu = buildMenuResponseFromTenantJson(tenantJson);

    // Plats: format legacy (strings) vs nouveau format ({nom, info})
    const aiPlats = normalizePlatsForAi(menu.carte_des_plats);
    menu.carte_des_plats = mode === "client" ? flattenPlatsForClient(aiPlats) : aiPlats;

    MENU_CACHE.set(cacheKey, menu);
    return menu;
}

// Menu par défaut (fallback)
const defaultMenu = getMenuForResto(null, "ai");

const client = HAS_MISTRAL_KEY ? new Mistral({ apiKey: process.env.MISTRAL_API_KEY }) : null;

/** Appel Mistral avec timeout 8 s (même logique que /ask). */
async function mistralChatComplete(messages, image) {
    const mistralController = new AbortController();
    const mistralTimeout = setTimeout(() => mistralController.abort(), 8000);
    try {
        const chatResponse = await client.chat.complete({
            model: image ? "pixtral-12b-2409" : "mistral-small-latest",
            temperature: 0.2,
            messages,
            signal: mistralController.signal
        });
        return chatResponse.choices[0].message.content;
    } finally {
        clearTimeout(mistralTimeout);
    }
}

function applyExplicationCasing(answer, targetLang) {
    let a = answer || "";
    if (targetLang === "fr") {
        a = a.replace(/\[EXPLICATION\]\s*:\s*nous\s+n'avons/i, "[EXPLICATION] : Nous n'avons");
    } else if (targetLang === "en") {
        a = a.replace(/\[EXPLICATION\]\s*:\s*we\s+don'?t\s+have/i, "[EXPLICATION] : We don't have");
    } else if (targetLang === "es") {
        a = a.replace(/\[EXPLICATION\]\s*:\s*no\s+tenemos/i, "[EXPLICATION] : No tenemos");
    }
    return a;
}

function checkBasicAuth(req) {
    const restoFromQuery = (() => {
        try {
            const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
            return u.searchParams.get("resto");
        } catch (e) {
            return null;
        }
    })();

    // Si jamais le frontend n'envoie pas `?resto=...`, on tente un fallback via body.
    const restoFromBody = (req._bodyJson && req._bodyJson.resto) ? req._bodyJson.resto : null;
    const restoId = restoFromQuery || restoFromBody || null;

    const safeResto = sanitizeRestoId(restoId);
    const targetPath = safeResto ? path.join(MENUS_DIR, `${safeResto}.json`) : DEFAULT_MENU_PATH;
    const finalPath = safeResto && fs.existsSync(targetPath) ? targetPath : DEFAULT_MENU_PATH;

    const tenantJson = readJsonSafe(finalPath) || {};
    const config = tenantJson && tenantJson.config ? tenantJson.config : {};
    const adminUser = config.admin_user;
    const adminPass = config.admin_pass;

    // Sécurité : si pas de credentials dans le JSON tenant, on refuse.
    if (!adminUser || !adminPass) return false;

    const auth = req.headers["authorization"];
    if (!auth || !auth.startsWith("Basic ")) return false;
    try {
        const b64 = auth.slice(6);
        const decoded = Buffer.from(b64, "base64").toString("utf8");
        const idx = decoded.indexOf(":");
        if (idx === -1) return false;
        const u = decoded.slice(0, idx);
        const p = decoded.slice(idx + 1);
        return u === adminUser && p === adminPass;
    } catch (e) {
        return false;
    }
}

function serve503(res, message) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ answer: message || "[ERREUR] Service temporairement indisponible." }));
}

function getClientIp(req) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) {
        return xff.split(",")[0].trim();
    }
    const xrip = req.headers["x-real-ip"];
    if (typeof xrip === "string" && xrip.trim()) return xrip.trim();
    return (req.socket && req.socket.remoteAddress) || req.connection?.remoteAddress || "unknown";
}

const askRateLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIp(req),
    handler: (req, res) => {
        if (!res.headersSent) {
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                answer: "[ERREUR] Le sommelier est très sollicité pour le moment, merci de patienter un instant avant de réessayer."
            }));
        }
    }
});

const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (req.method === "GET") {

        // API admin : statistiques (CA + mots-clés)
        if (req.url.startsWith("/api/admin/stats")) {
            if (!checkBasicAuth(req)) {
                res.writeHead(401, { "WWW-Authenticate": "Basic realm=\"Admin Stats\"" });
                res.end("Authentification requise.");
                return;
            }
            const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
            const restoId = u.searchParams.get("resto");
            const range = normalizeStatsRange(u.searchParams.get("range"));
            const statsData = loadStatsForResto(restoId);
            const topNRaw = parseInt(u.searchParams.get("topN") || "3", 10);
            const topN = [3, 5, 10].includes(topNRaw) ? topNRaw : 3;

            const suggestionEntries = Object.entries(statsData.suggestion_counts || {})
                .map(([vin, count]) => ({ vin, count: typeof count === "number" ? count : Number(count || 0) }))
                .sort((a, b) => b.count - a.count);
            const total_suggestions = suggestionEntries.reduce((acc, it) => acc + (it.count || 0), 0);
            const top_searches = suggestionEntries.slice(0, topN);
            // top_live_demands est calculé plus bas, une fois les logs live chargés,
            // pour pouvoir associer à chaque vin un plat.

            const menu_diff = readMenuDiffForResto(restoId);
            const types = mergeTypeCountsFromDisk(statsData.type_counts);
            const totalType =
                (types.Rouge || 0) +
                (types.Blanc || 0) +
                (types["Rosé"] || 0) +
                (types.ChampagneBulles || 0) +
                (types.Spiritueux || 0) +
                (types.Autres || 0);
            const pct = (n) => (totalType ? Math.round((n / totalType) * 100) : 0);
            const tendances = {
                Rouge: pct(types.Rouge || 0),
                Blanc: pct(types.Blanc || 0),
                "Rosé": pct(types["Rosé"] || 0),
                ChampagneBulles: pct(types.ChampagneBulles || 0),
                Spiritueux: pct(types.Spiritueux || 0),
                Autres: pct(types.Autres || 0)
            };
            // "Clients conseillés" = nombre de demandes enregistrées
            // On se base sur les logs (live + error) pour être cohérent même si les buckets daily n'existent pas.
            const live = Array.isArray(statsData.live_log) ? statsData.live_log : [];
            const errors = Array.isArray(statsData.error_log) ? statsData.error_log : [];

            const liveInRange = filterLogsByRange(live, range);
            const errorsInRange = filterLogsByRange(errors, range);

            // top_live_demands : questions les plus fréquentes (période = même filtre que le rapport)
            const questionCounts = {};
            for (const it of liveInRange) {
                if (!it) continue;
                const qStr = String(it.question || it.demande || it.q || "").trim();
                if (!qStr) continue;
                questionCounts[qStr] = (questionCounts[qStr] || 0) + 1;
            }
            const top_live_demands = Object.entries(questionCounts)
                .map(([question, count]) => ({ question, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, topN);

            // top_error_questions : comme top_live_demands, mais sur les demandes ayant généré une erreur / refus
            const errorQuestionCounts = {};
            for (const it of errorsInRange) {
                if (!it) continue;
                const qStr = getErrorLogQuestionKeyForTop(it);
                if (!qStr) continue;
                errorQuestionCounts[qStr] = (errorQuestionCounts[qStr] || 0) + 1;
            }
            const top_error_questions = Object.entries(errorQuestionCounts)
                .map(([question, count]) => ({ question, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, topN);

            const total_errors = errorsInRange.length;
            const live_total_range = range === "all" ? live.length : liveInRange.length;

            let clients_total_range = 0;
            if (range === "all") {
                clients_total_range = live.length + errors.length;
            } else {
                clients_total_range = liveInRange.length + errorsInRange.length;
            }

            const top_live_demands_5 = Object.entries(questionCounts)
                .map(([question, count]) => ({ question, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 5);
            const top_error_questions_5 = Object.entries(errorQuestionCounts)
                .map(([question, count]) => ({ question, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 5);

            const ic = statsData.interaction_counts || { flash: 0, texte_libre: 0, ouvrir_carte: 0, carte_vins: 0 };
            const icSum = (ic.flash || 0) + (ic.texte_libre || 0) + (ic.ouvrir_carte || 0) + (ic.carte_vins || 0);
            const icPct = (n) => (icSum ? Math.round((n / icSum) * 100) : 0);
            const interaction_repartition = {
                flash: icPct(ic.flash || 0),
                texte_libre: icPct(ic.texte_libre || 0),
                ouvrir_carte: icPct(ic.ouvrir_carte || 0),
                carte_vins: icPct(ic.carte_vins || 0),
                counts: {
                    flash: ic.flash || 0,
                    texte_libre: ic.texte_libre || 0,
                    ouvrir_carte: ic.ouvrir_carte || 0,
                    carte_vins: ic.carte_vins || 0
                },
                total: icSum
            };

            const combinedRange = [...liveInRange, ...errorsInRange];
            const chart_weekday_counts = computeWeekdayCountsFromLogs(combinedRange);
            const chart_weekday_labels = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
            const chart_monthly = computeMonthlyCountsFromLogs(live, errors, 24);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                clients_total_range,
                live_total_range,
                top_searches,
                total_suggestions,
                top_live_demands,
                top_error_questions,
                top_live_demands_5,
                top_error_questions_5,
                tendances,
                live_log: Array.isArray(statsData.live_log) ? statsData.live_log.slice(0, 20) : [],
                error_log: Array.isArray(statsData.error_log) ? statsData.error_log.slice(0, 20) : [],
                menu_diff,
                total_errors,
                interaction_counts: ic,
                interaction_repartition,
                last_updated: statsData.last_updated || null,
                range,
                chart_weekday: { labels: chart_weekday_labels, counts: chart_weekday_counts },
                chart_monthly
            }));
            return;
        }

        // Export CSV : mouchards complets (lecture fichier brut)
        if (req.url.startsWith("/api/admin/export-mouchards")) {
            if (!checkBasicAuth(req)) {
                res.writeHead(401, { "WWW-Authenticate": "Basic realm=\"Admin Export\"" });
                res.end("Authentification requise.");
                return;
            }
            const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
            const restoId = u.searchParams.get("resto");
            const rawPath = getStatsFilePath(restoId);
            const raw = readJsonSafe(rawPath) || {};
            const liveFull = Array.isArray(raw.live_log) ? raw.live_log : [];
            const errFull = Array.isArray(raw.error_log) ? raw.error_log : [];

            function escCell(v) {
                const s = v == null ? "" : String(v);
                return `"${s.replace(/"/g, '""')}"`;
            }

            const lines = [];
            lines.push("\ufeffsection,type,horodatage,question,vin_ou_message,type_vin");
            for (const it of liveFull) {
                const q = (it && it.question) || "";
                const vin = (it && it.vin) || "";
                const typ = (it && it.type) || "";
                lines.push(["MOUCHARD_LIVE", "live", it && it.ts ? it.ts : "", q, vin, typ].map(escCell).join(","));
            }
            lines.push("");
            lines.push("section,type,horodatage,question,message,");
            for (const it of errFull) {
                const q = (it && it.question) || "";
                const msg = (it && it.message) || "";
                lines.push(["MOUCHARD_ERROR", "error", it && it.ts ? it.ts : "", q, msg, ""].map(escCell).join(","));
            }

            const csv = lines.join("\r\n");
            const fname = `mouchards_${sanitizeRestoId(restoId) || "default"}_${new Date().toISOString().slice(0, 10)}.csv`;
            res.writeHead(200, {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": `attachment; filename="${fname}"`
            });
            res.end(csv);
            return;
        }

        // API admin protégée (lecture)
        if (req.url.startsWith("/api/admin/menu")) {
            if (!checkBasicAuth(req)) {
                res.writeHead(401, { "WWW-Authenticate": "Basic realm=\"Admin Menu\"" });
                res.end("Authentification requise.");
                return;
            }
            const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
            const restoId = u.searchParams.get("resto");
            const menu = getMenuForResto(restoId, "admin");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(menu));
            return;
        }

        // API publique de lecture du menu (utilisée par le front client)
        if (req.url.startsWith("/api/menu")) {
            const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
            const restoId = u.searchParams.get("resto");
            const menu = getMenuForResto(restoId, "client");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(menu));
            return;
        }

        const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

        // Page d'administration protégée par Basic Auth (admin / france)
        if (requestUrl.pathname === "/admin.html") {
            if (!checkBasicAuth(req)) {
                res.writeHead(401, { "WWW-Authenticate": "Basic realm=\"Admin Dashboard\"" });
                res.end("Authentification requise.");
                return;
            }
        }

        // Route courte : /admin (insensible à la casse) -> renvoie admin.html (protégé)
        if (requestUrl.pathname.toLowerCase() === "/admin") {
            if (!checkBasicAuth(req)) {
                res.writeHead(401, { "WWW-Authenticate": "Basic realm=\"Admin Dashboard\"" });
                res.end("Authentification requise.");
                return;
            }

            const adminFilePath = path.join(PUBLIC_DIR, "admin.html");
            fs.readFile(adminFilePath, (err, data) => {
                if (err) { res.writeHead(404); res.end("Not Found"); return; }
                res.writeHead(200, { "Content-Type": "text/html" });
                res.end(data);
            });
            return;
        }

        // Fichiers statiques : uniquement depuis public, anti path traversal
        let relativePath = req.url === "/" ? "app.html" : req.url.replace(/^\//, "").split("?")[0];
        relativePath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
        if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
            res.writeHead(403);
            res.end("Forbidden");
            return;
        }
        const filePath = path.join(PUBLIC_DIR, relativePath);
        const resolved = path.resolve(filePath);
        const resolvedPublic = path.resolve(PUBLIC_DIR);
        if (resolved !== resolvedPublic && !resolved.startsWith(resolvedPublic + path.sep)) {
            res.writeHead(403);
            res.end("Forbidden");
            return;
        }

        const ext = path.extname(filePath);
        let contentType = "text/html";
        if (ext === ".png") contentType = "image/png";
        if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
        if (ext === ".js") contentType = "application/javascript";
        if (ext === ".css") contentType = "text/css";

        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); res.end("Not Found"); return; }
            res.writeHead(200, { "Content-Type": contentType });
            res.end(data);
        });
        return;
    }

    /** Comptage interactions UI (app client) : flash, texte libre, carte menu, carte vins */
    if (req.method === "POST" && req.url.startsWith("/api/track")) {
        let body = "";
        req.on("data", chunk => {
            body += chunk;
        });
        req.on("end", () => {
            try {
                const data = JSON.parse(body || "{}");
                const action = String(data.action || "").trim();
                const allowed = new Set(["flash", "texte_libre", "ouvrir_carte", "carte_vins"]);
                if (!allowed.has(action)) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "action invalide" }));
                    return;
                }
                const restoRaw = data.resto != null ? String(data.resto) : "";
                const stats = loadStatsForResto(restoRaw);
                stats.interaction_counts = stats.interaction_counts || { flash: 0, texte_libre: 0, ouvrir_carte: 0, carte_vins: 0 };
                stats.interaction_counts[action] = (Number(stats.interaction_counts[action]) || 0) + 1;
                saveStatsForResto(restoRaw);
                res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                res.end(JSON.stringify({ ok: false }));
            }
        });
        return;
    }

    if (req.method === "POST" && req.url.startsWith("/ask")) {
        askRateLimiter(req, res, () => {
            if (!HAS_MISTRAL_KEY || !client) {
                serve503(res);
                return;
            }
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", async () => {
                try {
                    let { question, image, context, lang } = JSON.parse(body);
                    if (question && question.length > 500) question = question.substring(0, 500);
                    const targetLang = lang || "fr";

                    const askUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
                    const restoId = askUrl.searchParams.get("resto");
                    const tenantMenu = getMenuForResto(restoId, "ai");
                    const menuForPrompt = { carte_des_vins: tenantMenu.carte_des_vins, carte_des_plats: tenantMenu.carte_des_plats };

                    // Refus strict (anti-demande incohérente / vin absent)
                    const strictStop = strictRefusalIfNeeded(question, tenantMenu);
                    if (strictStop) {
                        try {
                            const tenantStats = loadStatsForResto(restoId);
                            const dayKey = getDayKey();
                            const cleanMsg = strictStop.replace(/^\[STOP\]\s*/i, "").trim().slice(0, 220);
                            tenantStats.daily_clients[dayKey] = (tenantStats.daily_clients[dayKey] || 0) + 1;
                            tenantStats.error_log = Array.isArray(tenantStats.error_log) ? tenantStats.error_log : [];
                            tenantStats.error_reason_counts = (tenantStats.error_reason_counts && typeof tenantStats.error_reason_counts === "object") ? tenantStats.error_reason_counts : {};
                            if (cleanMsg) tenantStats.error_reason_counts[cleanMsg] = (tenantStats.error_reason_counts[cleanMsg] || 0) + 1;
                            tenantStats.error_log.unshift({
                                ts: new Date().toISOString(),
                                question: (question || "").trim().slice(0, 140),
                                message: cleanMsg
                            });
                            if (tenantStats.error_log.length > 60) tenantStats.error_log = tenantStats.error_log.slice(0, 60);
                            saveStatsForResto(restoId);
                        } catch (e) {
                            console.error("Stats strictStop update error:", e);
                        }
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ answer: strictStop }));
                        return;
                    }

                    // Si la demande parle de "pousser" à la vente : on répond proprement en conseillant
                    // uniquement les vins [⭐ À POUSSER] de la carte (sans contenu marketing chelou).
                    const qStr = String(question || "");
                    const wantsPousserToSell = /\bpousser\b/i.test(qStr) && (/\bvente\b/i.test(qStr) || /\bvendre\b/i.test(qStr));
                    let pousserOverrideAnswer = null;
                    if (wantsPousserToSell) {
                        try {
                            const winesObj = tenantMenu && tenantMenu.carte_des_vins ? tenantMenu.carte_des_vins : {};
                            const allWines = [];
                            for (const wines of Object.values(winesObj)) {
                                if (!Array.isArray(wines)) continue;
                                for (const w of wines) if (w) allWines.push(w);
                            }
                            const pousserWines = allWines.filter(w => !!w.pousser);
                            const pickPool = pousserWines.length ? pousserWines : allWines;
                            const chosen = pickPool.slice(0, 3);

                            const suggestionLines = chosen
                                .map((w, idx) => {
                                    const nom = (w && (w.nom || w.name) ? (w.nom || w.name) : "").toString().trim();
                                    const type = (w && (w.type || w.categorie) ? (w.type || w.categorie) : "Autre").toString().trim();
                                    if (!nom) return "";
                                    return idx === 0 ? `${nom} (${type})` : `- ${nom} (${type})`;
                                })
                                .filter(Boolean)
                                .join('\n');

                            const explFR = "On vous conseille en priorité nos vins marqués [⭐ À POUSSER] : ce sont des choix qui plaisent facilement et qui restent cohérents avec la cave de la carte.";
                            const explEN = "We recommend first the wines marked [⭐ À POUSSER] in your menu: easy-to-like choices that stay consistent with the cave.";
                            const explES = "Recomendamos primero los vinos marcados con [⭐ À POUSSER] en el menú: elecciones fáciles y coherentes con la bodega.";

                            const explanation = targetLang === "en" ? explEN : targetLang === "es" ? explES : explFR;
                            const top = chosen[0] || null;
                            const topType = top && (top.type || top.categorie) ? (top.type || top.categorie) : "Rouge";

                            let aromas;
                            let profils;
                            let degre;
                            let avis;
                            let demLine;
                            if (targetLang === "en") {
                                aromas =
                                    topType === "Blanc"
                                        ? "- Citrus, white fruit\n- Floral notes"
                                        : topType === "Rosé"
                                          ? "- Red berries\n- Light freshness"
                                          : "- Ripe fruit, gentle spice\n- Indulgent notes";
                                profils = "- Power : 3/5\n- Freshness : 3/5\n- Roundness : 3/5";
                                degre = topType === "Blanc" ? "12% - Dry" : topType === "Rosé" ? "12.5% - Fresh" : "13.5% - Round";
                                avis = "At the table: pour and let it open for a minute. You'll feel the harmony between the wine and the meal.";
                                demLine = `[DEMANDE] : You want to highlight wines to promote tonight.\n`;
                            } else if (targetLang === "es") {
                                aromas =
                                    topType === "Blanc"
                                        ? "- Cítricos, fruta blanca\n- Notas florales"
                                        : topType === "Rosé"
                                          ? "- Frutos rojos\n- Frescura ligera"
                                          : "- Fruta madura, especias suaves\n- Notas golosas";
                                profils = "- Potencia : 3/5\n- Frescura : 3/5\n- Redondez : 3/5";
                                degre = topType === "Blanc" ? "12% - Seco" : topType === "Rosé" ? "12,5% - Fresco" : "13,5% - Redondo";
                                avis = "En mesa: sírvase y déjelo expresarse unos minutos. Notará la armonía entre el vino y el plato.";
                                demLine = `[DEMANDE] : Quiere destacar vinos para vender esta noche.\n`;
                            } else {
                                aromas =
                                    topType === "Blanc"
                                        ? "- Agrumes, fruits blancs\n- Notes florales"
                                        : topType === "Rosé"
                                          ? "- Fruits rouges\n- Fraîcheur légère"
                                          : "- Fruits mûrs, épices douces\n- Notes gourmandes";
                                profils = "- Puissance : 3/5\n- Fraîcheur : 3/5\n- Rondeur : 3/5";
                                degre = topType === "Blanc" ? "12% - Sec" : topType === "Rosé" ? "12,5% - Frais" : "13,5% - Rond";
                                avis = "Conseil à table : servez et laissez-le s'exprimer quelques minutes. Vous allez sentir la belle harmonie entre le vin et le repas.";
                                demLine = `[DEMANDE] : Vous voulez des vins à mettre en avant ce soir.\n`;
                            }

                            pousserOverrideAnswer =
                                demLine +
                                `[SUGGESTION] : ${suggestionLines}\n` +
                                `[EXPLICATION] : ${explanation}\n` +
                                `[AROMES] : ${aromas}\n` +
                                `[PROFIL_VIN] : ${profils}\n` +
                                `[DEGRE] : ${degre}\n` +
                                `[AVIS_SOMMELIER] : ${avis}`;
                        } catch (e) {
                            console.error("pousserOverrideAnswer error:", e);
                        }
                    }

                    let consigneSpeciale = "";
                    if (question.includes("Version Prestige") || question.includes("Prestige")) {
                        if (targetLang === "en") {
                            consigneSpeciale =
                                "SPECIAL RULE: The guest wants a treat (Prestige). Offer ONLY the most PREMIUM (most expensive/prestigious) wine in the compatible category from the menu.";
                        } else if (targetLang === "es") {
                            consigneSpeciale =
                                "REGLA ESPECIAL: El cliente quiere un capricho (Versión Prestige). Ofrece EXCLUSIVAMENTE el vino más PREMIUM (más caro/prestigioso) de la categoría compatible en la carta.";
                        } else {
                            consigneSpeciale =
                                "CONSIGNE SPÉCIALE : Le client veut se faire plaisir (Version Prestige). Propose EXCLUSIVEMENT le vin le plus HAUT DE GAMME (le plus cher/prestigieux) de la catégorie compatible dans le menu.";
                        }
                    }

                    const reglePousser =
                        targetLang === "en"
                            ? `Here is the wine list. Some wines are marked [⭐ À POUSSER]. If the guest's request matches PERFECTLY (same colour, good pairing), you MUST offer a [⭐ À POUSSER] wine first. Consistency wins. NEVER offer a red [⭐ À POUSSER] if the guest asked for white or the pairing is wrong.`
                            : targetLang === "es"
                              ? `Aquí está la carta de vinos. Algunos llevan [⭐ À POUSSER]. Si la petición encaja PERFECTAMENTE (mismo color, buen maridaje), debes proponer un vino [⭐ À POUSSER] con prioridad. La coherencia manda. NUNCA ofrezcas un [⭐ À POUSSER] tinto si pidieron blanco o el maridaje es malo.`
                              : `Voici la carte des vins. Certains vins ont la mention [⭐ À POUSSER]. Si la demande du client correspond PARFAITEMENT (même couleur, bon accord gustatif), tu dois proposer un vin [⭐ À POUSSER] en priorité absolue. ATTENTION : La cohérence prime. Ne propose JAMAIS un vin [⭐ À POUSSER] rouge si le client demande un blanc ou si l'accord est mauvais.`;

                    const menuJson = JSON.stringify(menuForPrompt);

                    const promptBaseFR = `Tu es le Sommelier du "Bistrot Français" (DÉMO).
                TON BUT : Faire saliver et vulgariser le vin pour un client non-expert.
                ${consigneSpeciale}
                
                RÈGLES D'OR :
                1. Pioche UNIQUEMENT dans le menu JSON.
                2. VULGARISATION TOTALE : Pas de jargon technique (pas de "tanins", "cépage", "caudalie").
                3. TOLÉRANCE FAUTES DE FRAPPE : Si le client écrit un plat avec une faute (ex: "frittes", "entrecote", "saumon fume"), une formulation proche ou une variante, considère qu'il s'agit du plat correspondant de la carte et propose l'accord. Ne refuse "[STOP] plat hors carte" que si la demande ne correspond à AUCUN plat du menu (ni de près ni de loin).
                4. SI LE VIN DEMANDÉ (nom/appellation/profil) N'EXISTE PAS DANS LA CARTE :
                   - Choisis le vin du menu le plus proche (couleur + accord gustatif).
                   - Dans [EXPLICATION], écris clairement : Nous n'avons pas exactement le vin demandé, mais voici l'alternative la plus cohérente.
                   - Cas DOUX / SUCRÉ / LIQUOREUX : si la carte n'offre pas ou peu ce profil, ne feins pas un accord parfait. Nuance honnêtement dans [EXPLICATION] (ex. : « nous n'avons pas de vin sucré en bouteille à la carte », « la bouteille la plus proche de votre envie est… », « ce n'est pas un moelleux, mais… »). Interdit de répondre avec un enthousiasme trompeur du type « oui, bien sûr » si ce n'est pas réellement le cas.
                5. PRIORITÉ ACCORD METS : si la demande contient des sections "Entrées:", "Plats:", "Desserts:" (ou équivalents), en cas de conflit suit d'abord "Plats", puis "Entrées", puis "Desserts".
                6. ENTRÉE + PLAT + DESSERT (conflit réel) : quand le vin choisi suit surtout le PLAT PRINCIPAL (règle 5) et qu'il serait nettement moins adapté à l'ENTRÉE seule (conflit de couleur ou d'accord évident), indique-le UNE FOIS dans [EXPLICATION], par ex. : « Ce vin est idéal avec votre plat principal, moins avec votre entrée ». Ne mentionne pas le dessert pour ce cas. Si tout est cohérent, n'ajoute pas cette phrase.
                7. SUIVI « AUTRE SUGGESTION » (rebond / message de suivi) : si le client demande une autre bouteille sans changer de type, propose une AUTRE référence du MÊME type (Rouge / Blanc / Rosé) et du même registre (sec, demi-sec, doux…). Ne bascule JAMAIS du rouge au blanc (ou l'inverse) sauf demande explicite. S'il n'existe qu'une seule option pertinente sur la carte (ex. un seul vin doux), dis-le avec franchise et repropose la même suggestion ou la meilleure approximation honnête — n'invente pas une seconde bouteille impossible.
                
                MENU DU BISTROT : ${menuJson}
                
                ${reglePousser}

                🛑 GESTION DES ERREURS :
                - Si insulte/hors-sujet : Réponds "[STOP] Désolé, je suis là uniquement pour vous conseiller le vin parfait."
                - Si plat vraiment hors carte (aucune correspondance possible avec le menu) : Réponds "[STOP] Désolé, ce plat n'est pas à notre carte."`;

                    const promptBaseEN = `You are the Sommelier at "Bistrot Français" (DEMO).
YOUR GOAL: Make the wine sound delicious and explain it simply for a non-expert guest.
${consigneSpeciale}

GOLDEN RULES:
1. Pick ONLY from the JSON menu.
2. PLAIN LANGUAGE: No technical jargon (no "tannins", "grape variety", etc.).
3. TOLERATE TYPOS: If the guest writes a dish with a typo or close variant, map it to the menu dish and offer a pairing. Only reply "[STOP] dish not on menu" if nothing matches at all.
4. IF THE REQUESTED WINE (name/appellation/profile) IS NOT ON THE LIST:
   - Choose the closest wine on the menu (colour + pairing).
   - In [EXPLICATION] say clearly: We don't have exactly the wine you asked for, but here is the closest match.
   - SWEET / OFF-DRY / LATE-HARVEST requests: if the list offers little or none, do NOT fake a perfect match. In [EXPLICATION] be honest (e.g. "we don't have a sweet bottle on the list", "the closest match to what you want is…", "this isn't a dessert wine, but…"). Do NOT say "absolutely" or "of course" if it isn't true.
5. Meal pairing priority: if the request has "Starters / Main / Desserts" (or equivalents), follow Main first, then Starters, then Desserts.
6. STARTER + MAIN + DESSERT (real clash): when the wine follows the MAIN COURSE first (rule 5) and would be clearly less ideal with the STARTER alone (colour/pairing clash), say it ONCE in [EXPLICATION], e.g. "This wine is ideal with your main course, less so with your starter." Do not mention dessert for this. If everything is coherent, skip this.
7. FOLLOW-UP "ANOTHER SUGGESTION": if the guest asks for another bottle without changing type, offer a DIFFERENT bottle of the SAME colour (red/white/rosé) and style (dry/off-dry/sweet…). Never flip red ↔ white unless they explicitly ask. If only one plausible option exists on the list (e.g. one sweet wine), say so honestly and propose the same wine or the best honest approximation — do not invent a second impossible bottle.

BISTROT MENU: ${menuJson}

${reglePousser}

ERROR HANDLING:
- Insult/off-topic: reply "[STOP] Sorry, I'm only here to help you find the perfect wine."
- Dish truly off-menu: reply "[STOP] Sorry, this dish is not on our menu."`;

                    const promptBaseES = `Eres el Sommelier del "Bistrot Français" (DEMO).
TU OBJETIVO: Hacer que el vino apetezca y explicarlo con sencillez a un cliente no experto.
${consigneSpeciale}

REGLAS DE ORO:
1. Elige SOLO del menú JSON.
2. LENGUAJE CLARO: Sin jerga técnica (sin "taninos", "cepa", etc.).
3. TOLERANCIA A ERRORES: Si el cliente escribe un plato con typo o variante cercana, mapéalo al plato de la carta y propón maridaje. Solo responde "[STOP] plato fuera de carta" si no hay ninguna coincidencia.
4. SI EL VINO PEDIDO (nombre/appellation/perfil) NO ESTÁ EN LA CARTA:
   - Elige el vino más cercano (color + maridaje).
   - En [EXPLICATION] di claramente: No tenemos exactamente el vino pedido, pero aquí está la alternativa más coherente.
   - VINOS DULCES / LICOROSOS: si la carta casi no ofrece ese perfil, no finjas un maridaje perfecto. En [EXPLICATION] sé honesto ("no tenemos un vino dulce en botella", "la botella más cercana a lo que busca es…", "no es un vino de postre, pero…"). Prohibido un "¡por supuesto!" engañoso si no es cierto.
5. Prioridad de maridaje: si hay secciones "Entradas / Platos / Postres", en conflicto sigue primero "Platos", luego "Entradas", luego "Postres".
6. ENTRADA + PLATO + POSTRE (conflicto real): si el vino sigue sobre todo el PLATO PRINCIPAL (regla 5) y encaja claramente peor con la ENTRADA sola (choque de color/maridaje), díelo UNA VEZ en [EXPLICATION], ej.: "Este vino es ideal con su plato principal, menos con su entrada." No menciones el postre en este caso. Si todo encaja, omítelo.
7. SEGUIMIENTO "OTRA SUGERENCIA": si el cliente pide otra botella sin cambiar de tipo, ofrece otra referencia del MISMO tipo (tinto/blanco/rosado) y registro (seco/dulce…). Nunca cambies tinto ↔ blanco salvo petición explícita. Si solo hay una opción plausible en carta (ej. un solo vino dulce), dilo con franqueza y vuelve a proponer la misma u la mejor aproximación honesta — no inventes una segunda botella imposible.

MENÚ DEL BISTROT: ${menuJson}

${reglePousser}

GESTIÓN DE ERRORES:
- Insulto/tema fuera: responde "[STOP] Lo siento, solo estoy aquí para ayudarte a encontrar el vino perfecto."
- Plato realmente fuera de carta: responde "[STOP] Lo siento, este plato no está en nuestra carta."`;

                    const promptBase = targetLang === "en" ? promptBaseEN : targetLang === "es" ? promptBaseES : promptBaseFR;

                    const formatFR = `FORMAT DE RÉPONSE OBLIGATOIRE (Respecte les tirets) :
                
                [DEMANDE] : 
                (C'est la section LOGIQUE INVERSE. Fais très attention ici.)
                - Si l'utilisateur demande un PLAT -> Liste uniquement le champ "nom" de ce plat avec un tiret (NE PAS inclure le champ "info").
                - Si l'utilisateur demande un TYPE DE VIN (ex: "Je cherche un vin...", "Je veux du Blanc") -> NE RÉPÈTE PAS "VIN BLANC". À la place, LISTE uniquement le champ "nom" des plats du menu qui vont bien avec ce vin. (ex: "- Saumon", "- Fromage").
                
                [SUGGESTION] : (Nom exact du vin) (Type entre parenthèses)
                
                [EXPLICATION] : (Pourquoi ce choix ? RÈGLE ABSOLUE : NE RÉPÈTE PAS LE NOM DU VIN. Utilise "Il", "Ce vin", "Cette cuvée". Fais saliver. Si le vin suit surtout le plat principal et l'entrée aurait mieux convenu à un autre type : dis-le brièvement. Si la demande — notamment doux/sucré — ne peut pas être satisfaite à l'identique : nuance honnêtement, sans faux enthousiasme.)
                
                [AROMES] : (Liste verticale. Format: "- Famille (Exemple 1, Exemple 2)". Max 3 lignes. PAS de mots techniques.)
                - Famille 1 (Arôme, Arôme)
                - Famille 2 (Arôme)
                
                [PROFIL_VIN] : (3 critères simples pour le client, notés sur 5. Choisis parmi : Puissance, Fraîcheur, Rondeur, Fruité, Sucrosité. Un par ligne.)
                - Critère 1 : X/5
                - Critère 2 : X/5
                - Critère 3 : X/5
                
                [DEGRE] : (Ex: 13% - Sec / ou / 12% - Demi-sec)
                
                [AVIS_SOMMELIER] : (Un conseil DÉGUSTATION pour le client à table. INTERDIT de dire "Servir", "Caraf", "Ouvrir". Dis plutôt : "Faites-le tourner dans le verre pour...", "Prenez le temps de sentir...", "Gardez-le un peu en bouche...", "Idéal à boire maintenant". Ton complice et humain.)`;

                    const formatEN = `MANDATORY RESPONSE FORMAT (keep the dash bullets):

[DEMANDE] :
(Inverse-logic section. Be careful.)
- If the guest asks for a DISH -> list only the dish "nom" field with a dash (do NOT include "info").
- If the guest asks for a WINE TYPE (e.g. "I'm looking for...", "I want white") -> do NOT repeat "WHITE WINE". Instead list only the "nom" of menu dishes that pair well (e.g. "- Salmon", "- Cheese").

[SUGGESTION] : (Exact wine name) (Type in parentheses)

[EXPLICATION] : (Why this choice? RULE: DO NOT repeat the wine name. Use "It", "This wine", "This cuvée". Make it mouth-watering. If the wine mainly follows the main course while the starter would suit another style, say so briefly. If the guest's request — especially sweet — cannot be met exactly, be honest and nuanced, no fake enthusiasm.)

[AROMES] : (Vertical list. Format: "- Family (Example 1, Example 2)". Max 3 lines. No technical jargon.)
- Family 1 (Aroma, Aroma)
- Family 2 (Aroma)

[PROFIL_VIN] : (3 simple criteria for the guest, scored /5. Pick from: Power, Freshness, Roundness, Fruitiness, Sweetness. One per line.)
- Criterion 1 : X/5
- Criterion 2 : X/5
- Criterion 3 : X/5

[DEGRE] : (e.g. 13% - Dry / or / 12% - Off-dry)

[AVIS_SOMMELIER] : (A TASTING tip for the guest. Do NOT say "Serve", "Decant", "Open". Say things like: "Swirl it in the glass to...", "Take time to smell...", "Hold it on the palate...", "Ideal to drink now". Warm, human tone.)`;

                    const formatES = `FORMATO DE RESPUESTA OBLIGATORIO (respeta los guiones):

[DEMANDE] :
(Sección de lógica inversa. ¡Cuidado!)
- Si el usuario pide un PLATO -> lista solo el campo "nom" del plato con guión (NO incluyas "info").
- Si pide un TIPO DE VINO (ej. "Busco un vino...", "Quiero blanco") -> NO repitas "VINO BLANCO". En su lugar lista solo el "nom" de los platos del menú que maridan bien (ej. "- Salmón", "- Queso").

[SUGGESTION] : (Nombre exacto del vino) (Tipo entre paréntesis)

[EXPLICATION] : (¿Por qué esta elección? REGLA: NO repitas el nombre del vino. Usa "Este vino", "Esta cuvée". Que apetezca. Si el vino sigue sobre todo el plato principal y la entrada pedía otro estilo, dilo con brevedad. Si la petición —en especial dulce— no puede cumplirse al pie de la letra, sé honesto y matiza, sin entusiasmo falso.)

[AROMES] : (Lista vertical. Formato: "- Familia (Ejemplo 1, Ejemplo 2)". Máx. 3 líneas. Sin tecnicismos.)
- Familia 1 (Aroma, Aroma)
- Familia 2 (Aroma)

[PROFIL_VIN] : (3 criterios simples para el cliente, notados /5. Elige entre: Potencia, Frescura, Redondez, Frutosidad, Dulzor. Uno por línea.)
- Criterio 1 : X/5
- Criterio 2 : X/5
- Criterio 3 : X/5

[DEGRE] : (Ej. 13% - Seco / o / 12% - Semiseco)

[AVIS_SOMMELIER] : (Un consejo de DEGUSTACIÓN en mesa. PROHIBIDO decir "Servir", "Decantar", "Abrir". Di cosas como: "Gírelo en la copa para...", "Tómese tiempo para oler...", "Déjelo en boca...", "Ideal para beber ahora". Tono cercano.)`;

                    const formatBlock = targetLang === "en" ? formatEN : targetLang === "es" ? formatES : formatFR;

                    const langDirective =
                        targetLang === "en"
                            ? `CRITICAL: Write the ENTIRE answer in English. All text inside [DEMANDE], [SUGGESTION], [EXPLICATION], [AROMES], [PROFIL_VIN], [DEGRE], [AVIS_SOMMELIER] must be English. Do not write French sentences in the body (wine names and menu items may stay as on the menu).\n\n`
                            : targetLang === "es"
                              ? `CRÍTICO: Escribe TODA la respuesta en español. Todo el contenido debe estar en español. No escribas frases en francés en el cuerpo (los nombres del menú pueden quedar como en la carta).\n\n`
                              : "";

                    let systemPrompt = langDirective + promptBase + "\n" + formatBlock;

                    let messages = [{ role: "system", content: systemPrompt }];
                    if (image) {
                        const imageHint =
                            targetLang === "en"
                                ? "\n\nAnalyze this label:"
                                : targetLang === "es"
                                  ? "\n\nAnaliza esta etiqueta:"
                                  : "\n\nAnalyse cette étiquette :";
                        messages = [{ role: "user", content: [
                            { type: "text", text: systemPrompt + imageHint },
                            { type: "image_url", imageUrl: image }
                        ] }];
                    } else {
                        messages = messages.concat(context || []);
                        messages.push({ role: "user", content: question });
                    }

                    let answer = "";
                    if (pousserOverrideAnswer) {
                        answer = pousserOverrideAnswer;
                    } else {
                        try {
                            answer = await mistralChatComplete(messages, image);
                        } catch (err) {
                            const isTimeout =
                                err?.name === "AbortError" ||
                                /timeout|timed out|aborted/i.test(String(err && err.message ? err.message : ""));
                            if (isTimeout) {
                                try {
                                    if (!image && question) {
                                        const tenantStats = loadStatsForResto(restoId);
                                        const dayKey = getDayKey();
                                        tenantStats.daily_clients[dayKey] = (tenantStats.daily_clients[dayKey] || 0) + 1;
                                        tenantStats.error_log = Array.isArray(tenantStats.error_log) ? tenantStats.error_log : [];
                                        tenantStats.error_reason_counts = (tenantStats.error_reason_counts && typeof tenantStats.error_reason_counts === "object") ? tenantStats.error_reason_counts : {};
                                        const timeoutMsg = "Le sommelier est très demandé, veuillez réessayer dans un instant.";
                                        tenantStats.error_reason_counts[timeoutMsg] = (tenantStats.error_reason_counts[timeoutMsg] || 0) + 1;
                                        tenantStats.error_log.unshift({
                                            ts: new Date().toISOString(),
                                            question: (question || "").trim().slice(0, 140),
                                            message: timeoutMsg
                                        });
                                        if (tenantStats.error_log.length > 60) tenantStats.error_log = tenantStats.error_log.slice(0, 60);
                                        saveStatsForResto(restoId);
                                    }
                                } catch (logErr) {
                                    console.error("Stats timeout update error:", logErr);
                                }
                                res.writeHead(200, { "Content-Type": "application/json" });
                                res.end(JSON.stringify({ answer: "[ERREUR] Le sommelier est très demandé, veuillez réessayer dans un instant." }));
                                return;
                            }
                            throw err;
                        }
                    }
                    answer = applyExplicationCasing(answer, targetLang);

                    // Validation carte : le vin dans [SUGGESTION] doit correspondre à une bouteille (nom) du menu JSON
                    if (!pousserOverrideAnswer && answer && !String(answer).trim().startsWith("[STOP]") && !String(answer).includes("[ERREUR]")) {
                        let fix = tryFixSuggestionToMenu(answer, tenantMenu.carte_des_vins);
                        if (fix.ok) {
                            answer = fix.answer;
                        } else if (fix.reason === "no_match") {
                            try {
                                const messagesRetry = [
                                    ...messages,
                                    { role: "assistant", content: answer },
                                    { role: "user", content: correctionPromptForInvalidWine(targetLang) }
                                ];
                                answer = await mistralChatComplete(messagesRetry, image);
                                answer = applyExplicationCasing(answer, targetLang);
                                fix = tryFixSuggestionToMenu(answer, tenantMenu.carte_des_vins);
                                if (fix.ok) {
                                    answer = fix.answer;
                                } else if (fix.reason === "no_match") {
                                    console.warn("[wine-match] Validation carte refusée après retry:", { score: fix.score, resto: restoId });
                                    answer = "[ERREUR] Impossible de valider la suggestion sur la carte. Veuillez réessayer.";
                                }
                            } catch (retryErr) {
                                const isTimeout =
                                    retryErr?.name === "AbortError" ||
                                    /timeout|timed out|aborted/i.test(String(retryErr && retryErr.message ? retryErr.message : ""));
                                if (isTimeout) {
                                    answer = "[ERREUR] Le sommelier est très demandé, veuillez réessayer dans un instant.";
                                } else {
                                    console.error("[wine-match] Erreur retry validation:", retryErr);
                                    answer = "[ERREUR] Impossible de finaliser la suggestion. Veuillez réessayer.";
                                }
                            }
                        }
                    }

                    // Envoi en arrière-plan vers le Webhook Make avec les infos structurées
                    try {
                        // Extraction précise du vin et du type à partir du bloc [SUGGESTION]
                        // Format garanti : [SUGGESTION] : Nom du vin (Type)
                        let extractVin = "";
                        let extractType = "";

                        const suggestionMatch = answer.match(/\[SUGGESTION\]\s*:\s*(.+?)\s*\(([^)]+)\)/i);
                        if (suggestionMatch) {
                            extractVin = (suggestionMatch[1] || "").trim();
                            extractType = (suggestionMatch[2] || "").trim();
                        }

                        const payload = {
                            demande: question || "",
                            vin: extractVin,
                            type: extractType,
                            date: new Date().toISOString()
                        };

                        // Appel non bloquant : on ne l'await pas pour ne pas impacter la réponse au client
                        fetch("https://hook.eu1.make.com/s5l612gywl8l33e9238koif2cb556bbd", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(payload)
                        }).catch(() => {});
                    } catch (err) {
                        // L'échec de l'envoi vers Make ne doit pas empêcher la réponse au client
                        console.error("Erreur lors de l'envoi au Webhook Make :", err);
                    }

                    // Stats : on compte chaque demande (clients) + séparation live vs error
                    try {
                        if (!image && question) {
                            const tenantStats = loadStatsForResto(restoId);
                            const dayKey = getDayKey();
                            tenantStats.daily_clients[dayKey] = (tenantStats.daily_clients[dayKey] || 0) + 1;

                            const isStop = answer && typeof answer === "string" && (answer.trim().startsWith("[STOP]") || answer.includes("[ERREUR]"));
                            const suggestionMatch = answer ? answer.match(/\[SUGGESTION\]\s*:\s*(.+?)\s*\(([^)]+)\)/i) : null;

                            tenantStats.live_log = Array.isArray(tenantStats.live_log) ? tenantStats.live_log : [];
                            tenantStats.error_log = Array.isArray(tenantStats.error_log) ? tenantStats.error_log : [];

                            if (!isStop && suggestionMatch) {
                                const extractVin = (suggestionMatch[1] || "").trim();
                                const extractType = (suggestionMatch[2] || "").trim();

                                tenantStats.suggestion_counts[extractVin] = (tenantStats.suggestion_counts[extractVin] || 0) + 1;
                                const typeKey = normalizeTypeForStats(extractType);
                                tenantStats.type_counts[typeKey] = (tenantStats.type_counts[typeKey] || 0) + 1;

                                tenantStats.live_log.unshift({
                                    ts: new Date().toISOString(),
                                    question: (question || "").trim().slice(0, 140),
                                    vin: extractVin,
                                    type: extractType
                                });
                                if (tenantStats.live_log.length > 60) tenantStats.live_log = tenantStats.live_log.slice(0, 60);
                            } else {
                                // Erreur / refus / réponse non structurée
                                const cleanMsg = (answer || "")
                                    .toString()
                                    .replace(/^\[STOP\]\s*/i, "")
                                    .replace(/\[ERREUR\]\s*/i, "")
                                    .trim()
                                    .slice(0, 220);

                                tenantStats.error_reason_counts = (tenantStats.error_reason_counts && typeof tenantStats.error_reason_counts === "object") ? tenantStats.error_reason_counts : {};
                                if (cleanMsg) tenantStats.error_reason_counts[cleanMsg] = (tenantStats.error_reason_counts[cleanMsg] || 0) + 1;

                                tenantStats.error_log.unshift({
                                    ts: new Date().toISOString(),
                                    question: (question || "").trim().slice(0, 140),
                                    message: cleanMsg || "Requête refusée / réponse non structurée."
                                });
                                if (tenantStats.error_log.length > 60) tenantStats.error_log = tenantStats.error_log.slice(0, 60);
                            }
                            saveStatsForResto(restoId);
                        }
                    } catch (e) {
                        console.error("Stats update error:", e);
                    }

                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ answer: answer }));
                } catch (e) {
                    console.error(e);
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ answer: "[STOP] Désolé, une erreur technique est survenue. Veuillez réessayer." }));
                }
            });
        });
        return;
    }

    if (req.method === "POST" && req.url.startsWith("/api/menu")) {
        const menuUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const restoId = menuUrl.searchParams.get("resto");
        const safeResto = sanitizeRestoId(restoId);
        const targetPath = safeResto ? path.join(MENUS_DIR, `${safeResto}.json`) : DEFAULT_MENU_PATH;
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            try {
                const data = JSON.parse(body);
                if (!data.carte_des_plats || !data.carte_des_vins) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "carte_des_plats et carte_des_vins requis" }));
                    return;
                }

                // Auth Basic multi-clients après parsing du body (sécurité + resto potentiellement côté requête).
                req._bodyJson = data;
                if (!checkBasicAuth(req)) {
                    res.writeHead(401, { "WWW-Authenticate": "Basic realm=\"Admin Carte\"" });
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ ok: false, error: "Authentification requise." }));
                    return;
                }

                const validation = validateMenuPayload(data);
                if (!validation.ok) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "Validation échouée.", details: validation.errors, warnings: validation.warnings }));
                    return;
                }

                const existingTenant = readJsonSafe(targetPath) || readJsonSafe(DEFAULT_MENU_PATH) || {};
                const configToKeep = existingTenant.config || defaultMenu.config || {};

                // Conversion : { carte_des_vins: { [categorie]: Wine[] } } -> { vins: [{ categorie, ...Wine, pousser }] }
                const vins = [];
                Object.entries(data.carte_des_vins || {}).forEach(([categorie, wines]) => {
                    if (!Array.isArray(wines)) return;
                    wines.forEach(w => {
                        vins.push({
                            categorie,
                            nom: w && (w.nom || w.name || "") || "",
                            domaine: w && (w.domaine || "") || "",
                            annee: w && (w.annee || "") || "",
                            prix_bouteille: w && (w.prix_bouteille || w.prixBouteille || "") || "",
                            prix_verre: w && (w.prix_verre || w.prixVerre || "") || "",
                            prix: w && (w.prix || w.price || w.prix_bouteille || w.prixBouteille || w.prix_verre || w.prixVerre || "") || "",
                            type: w && (w.type || "") || "",
                            pousser: !!(w && w.pousser)
                        });
                    });
                });

                const tenantToWrite = {
                    config: configToKeep,
                    carte_des_plats: data.carte_des_plats,
                    vins
                };

                const existedBefore = fs.existsSync(targetPath);
                fs.writeFileSync(targetPath, JSON.stringify(tenantToWrite, null, 2), "utf8");
                writeMenuDiffAfterSave(restoId, existingTenant, data);
                // Invalidate le cache multi-modes (client/ai/admin) pour ce tenant
                for (const key of Array.from(MENU_CACHE.keys())) {
                    if (key.startsWith(targetPath + "::") || (!existedBefore && key.startsWith(DEFAULT_MENU_PATH + "::"))) {
                        MENU_CACHE.delete(key);
                    }
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, warnings: validation.warnings }));
            } catch (e) {
                console.error("POST /api/menu error:", e);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    res.writeHead(404);
    res.end("Not Found");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`Serveur DÉMO en ligne sur le port ${PORT}`);
});
