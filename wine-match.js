/**
 * Correspondance vin suggéré ↔ carte (noms normalisés + score).
 * Utilisé par server.js pour la validation post-IA.
 */

function normalizeVinName(n) {
    let s = (n || "").toString().trim().toLowerCase();
    s = s.replace(/œ/g, "oe").replace(/æ/g, "ae").replace(/ß/g, "ss");
    s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    s = s.replace(/[^a-z0-9\s'\-]/g, " ");
    return s.replace(/\s+/g, " ").trim();
}

function tokenize(s) {
    return normalizeVinName(s).split(" ").filter(Boolean);
}

function levenshteinDistance(a, b) {
    const s = a || "";
    const t = b || "";
    const n = s.length;
    const m = t.length;
    if (n === 0) return m;
    if (m === 0) return n;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 0; i <= n; i++) dp[i][0] = i;
    for (let j = 0; j <= m; j++) dp[0][j] = j;
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const cost = s[i - 1] === t[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }
    return dp[n][m];
}

function computeWineMatchScore(targetName, candidateName) {
    const target = normalizeVinName(targetName);
    const candidate = normalizeVinName(candidateName);
    if (!target || !candidate) return 0;
    if (target === candidate) return 1;

    let score = 0;
    if (target.length >= 4 && candidate.length >= 4 && (target.includes(candidate) || candidate.includes(target))) {
        score = Math.max(score, 0.88);
    }

    const targetTokens = tokenize(target);
    const candidateTokens = tokenize(candidate);
    const targetSet = new Set(targetTokens);
    const candidateSet = new Set(candidateTokens);
    const inter = [...targetSet].filter(x => candidateSet.has(x)).length;
    const union = new Set([...targetSet, ...candidateSet]).size || 1;
    const jaccard = inter / union;
    score = Math.max(score, jaccard * 0.85);

    const maxLen = Math.max(target.length, candidate.length) || 1;
    const dist = levenshteinDistance(target, candidate);
    const similarity = 1 - dist / maxLen;
    score = Math.max(score, similarity * 0.8);

    return Math.max(0, Math.min(1, score));
}

const MIN_WINE_MENU_MATCH_SCORE = 0.76;

function findBestMenuWineForSuggestion(suggestedName, carte_des_vins) {
    let bestWine = null;
    let bestScore = 0;
    const cats = carte_des_vins && typeof carte_des_vins === "object" ? carte_des_vins : {};
    for (const wines of Object.values(cats)) {
        if (!Array.isArray(wines)) continue;
        for (const w of wines) {
            const nom = w && (w.nom || w.name);
            if (!nom) continue;
            const score = computeWineMatchScore(suggestedName, nom);
            if (score > bestScore) {
                bestScore = score;
                bestWine = w;
            }
        }
    }
    return bestWine ? { wine: bestWine, score: bestScore } : null;
}

function replaceSuggestionFirstLine(answer, canonicalNom, canonicalType) {
    const t = (canonicalType || "").trim() || "Autre";
    const safeNom = String(canonicalNom || "").trim();
    return answer.replace(/(\[SUGGESTION\]\s*:\s*)([^\n\r]+)/m, `$1${safeNom} (${t})`);
}

/**
 * @returns {{ ok: true, answer: string } | { ok: false, reason: 'no_suggestion' | 'no_match', score?: number }}
 */
function tryFixSuggestionToMenu(answer, carte_des_vins) {
    const m = answer.match(/\[SUGGESTION\]\s*:\s*(.+?)\s*\(([^)]+)\)/is);
    if (!m) return { ok: false, reason: "no_suggestion" };
    const rawName = (m[1] || "").trim();
    const firstLine = rawName.split(/\n/)[0].trim();
    const best = findBestMenuWineForSuggestion(firstLine, carte_des_vins);
    if (!best || best.score < MIN_WINE_MENU_MATCH_SCORE) {
        return { ok: false, reason: "no_match", score: best ? best.score : 0 };
    }
    const nom = (best.wine.nom || best.wine.name || "").trim();
    const typ = (best.wine.type || "").trim() || "Autre";
    return { ok: true, answer: replaceSuggestionFirstLine(answer, nom, typ) };
}

function correctionPromptForInvalidWine(targetLang) {
    if (targetLang === "en") {
        return "VALIDATION: The wine name in [SUGGESTION] was not found on the menu JSON. Reply again with the FULL same format (all sections), and for [SUGGESTION] copy-paste EXACTLY the bottle name from the menu field \"nom\" and its type in parentheses.";
    }
    if (targetLang === "es") {
        return "VALIDACIÓN: El nombre del vino en [SUGGESTION] no coincide con la carta JSON. Responde de nuevo con el MISMO formato completo (todas las secciones), y en [SUGGESTION] copia EXACTAMENTE el nombre de la botella del campo \"nom\" del menú y su tipo entre paréntesis.";
    }
    return "VALIDATION : Le nom du vin dans [SUGGESTION] ne correspond pas à la carte JSON. Réponds de nouveau avec le MÊME format complet (toutes les sections), et pour [SUGGESTION] copie-colle EXACTEMENT le nom d'une bouteille du menu (champ \"nom\") et son type entre parenthèses.";
}

module.exports = {
    normalizeVinName,
    tokenize,
    levenshteinDistance,
    computeWineMatchScore,
    MIN_WINE_MENU_MATCH_SCORE,
    findBestMenuWineForSuggestion,
    replaceSuggestionFirstLine,
    tryFixSuggestionToMenu,
    correctionPromptForInvalidWine
};
