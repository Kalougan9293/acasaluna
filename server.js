// CORRECTION : Try/catch pour éviter le crash dotenv sur Render
try { require('dotenv').config(); } catch (e) { console.log("Mode Production"); }

const { Mistral } = require('@mistralai/mistralai');
const http = require("http");
const fs = require("fs");
const path = require("path");

// --- CHARGEMENT DU MENU DEMO ---
let menuData = { carte_des_vins: {}, carte_des_plats: {} };
try {
    menuData = require('./menu.json');
    console.log("✅ MENU DEMO CHARGÉ");
} catch (error) {
    console.log("⚠️ Menu introuvable, mode dégradé.");
}

const client = new Mistral({apiKey: process.env.MISTRAL_API_KEY});

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === "GET") {
        
        // --- ZONE ADMIN DEMO (Login: admin / Pass: demo123) ---
        if (req.url === "/admin-secret-stats") {
            const ADMIN_USER = "admin";
            const ADMIN_PASS = "demo123"; 

            const auth = req.headers['authorization'];
            if (!auth) {
                res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Demo Admin"' });
                res.end('Authentification requise.');
                return;
            }
            const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
            if (credentials[0] === ADMIN_USER && credentials[1] === ADMIN_PASS) {
                let journal = "Vide"; let avisNeg = "Vide"; let likes = "0";
                try { if (fs.existsSync('./journal_complet.txt')) journal = fs.readFileSync('./journal_complet.txt', 'utf8'); } catch(e){}
                try { if (fs.existsSync('./avis_NEGATIFS.txt')) avisNeg = fs.readFileSync('./avis_NEGATIFS.txt', 'utf8'); } catch(e){}
                try { if (fs.existsSync('./total_likes.txt')) likes = fs.readFileSync('./total_likes.txt', 'utf8'); } catch(e){}

                res.writeHead(200, { "Content-Type": "text/html" });
                res.end(`<html><body style="font-family:sans-serif; padding:20px;"><h1>📊 Stats Démo</h1><p>Likes: <b>${likes}</b></p><hr><pre>${journal}</pre></body></html>`);
                return;
            } else {
                res.writeHead(401); res.end('Bad Password'); return;
            }
        }

        let filePath = req.url === "/" ? "app.html" : req.url.substring(1);
        const ext = path.extname(filePath);
        if (ext === ".txt" || ext === ".env" || (ext === ".json" && filePath !== "menu.json")) {
            res.writeHead(403); res.end("⛔ SECCURITÉ DEMO"); return;
        }

        let contentType = "text/html";
        if (ext === ".png") contentType = "image/png";
        if (ext === ".jpg") contentType = "image/jpeg";
        if (ext === ".js") contentType = "application/javascript";
        if (ext === ".css") contentType = "text/css";

        fs.readFile(path.join(__dirname, filePath), (err, data) => {
            if (err) { res.writeHead(404); res.end("404"); return; }
            res.writeHead(200, { "Content-Type": contentType });
            res.end(data);
        });

    } else if (req.method === "POST" && req.url === "/ask") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
            try {
                let { question, image, context, lang } = JSON.parse(body);
                if (question && question.length > 500) question = question.substring(0, 500);
                const targetLang = lang || 'fr';
                
                // --- LOGIQUE "PRESTIGE" ---
                let consigneSpeciale = "";
                if (question.includes("Version Prestige") || question.includes("Prestige")) {
                    consigneSpeciale = "CONSIGNE SPÉCIALE : Le client veut se faire plaisir (Version Prestige). Propose EXCLUSIVEMENT le vin le plus HAUT DE GAMME (le plus cher/prestigieux) de la catégorie compatible dans le menu.";
                }

                // --- PROMPTS ADAPTÉS POUR LA DÉMO ---
                const promptBase = `Tu es le Sommelier du "Bistrot Français" (DÉMO).
                TON BUT : Faire saliver et vulgariser le vin pour un client non-expert.
                ${consigneSpeciale}
                
                RÈGLES D'OR :
                1. Pioche UNIQUEMENT dans le menu JSON.
                2. VULGARISATION TOTALE : Pas de jargon technique (pas de "tanins", "cépage", "caudalie").
                
                MENU DU BISTROT : ${JSON.stringify(menuData)}

                🛑 GESTION DES ERREURS :
                - Si insulte/hors-sujet : Réponds "[STOP] Désolé, je suis là uniquement pour vous conseiller le vin parfait."
                - Si plat hors carte : Réponds "[STOP] Désolé, ce plat n'est pas à notre carte."`;

                const formatFR = `FORMAT DE RÉPONSE OBLIGATOIRE (Respecte les tirets) :
                
                [DEMANDE] : 
                (C'est la section LOGIQUE INVERSE. Fais très attention ici.)
                - Si l'utilisateur demande un PLAT -> Liste simplement ce plat avec un tiret.
                - Si l'utilisateur demande un TYPE DE VIN (ex: "Je cherche un vin...", "Je veux du Blanc") -> NE RÉPÈTE PAS "VIN BLANC". À la place, LISTE les plats du menu qui vont bien avec ce vin. (ex: "- Saumon", "- Fromage").
                
                [SUGGESTION] : (Nom exact du vin) (Type entre parenthèses)
                
                [EXPLICATION] : (Pourquoi ce choix ? RÈGLE ABSOLUE : NE RÉPÈTE PAS LE NOM DU VIN. Utilise "Il", "Ce vin", "Cette cuvée". Fais saliver.)
                
                [AROMES] : (Liste verticale. Format: "- Famille (Exemple 1, Exemple 2)". Max 3 lignes. PAS de mots techniques.)
                - Famille 1 (Arôme, Arôme)
                - Famille 2 (Arôme)
                
                [PROFIL_VIN] : (3 critères simples pour le client, notés sur 5. Choisis parmi : Puissance, Fraîcheur, Rondeur, Fruité, Sucrosité. Un par ligne.)
                - Critère 1 : X/5
                - Critère 2 : X/5
                - Critère 3 : X/5
                
                [DEGRE] : (Ex: 13% - Sec / ou / 12% - Demi-sec)
                
                [AVIS_SOMMELIER] : (Un conseil DÉGUSTATION pour le client à table. INTERDIT de dire "Servir", "Caraf", "Ouvrir". Dis plutôt : "Faites-le tourner dans le verre pour...", "Prenez le temps de sentir...", "Gardez-le un peu en bouche...", "Idéal à boire maintenant". Ton complice et humain.)`;

                let systemPrompt = promptBase + "\n" + formatFR;
                if(targetLang === 'en') systemPrompt += " ANSWER IN ENGLISH.";
                if(targetLang === 'es') systemPrompt += " ANSWER IN SPANISH.";

                let messages = [{ role: 'system', content: systemPrompt }];
                if (image) {
                    messages = [{ role: 'user', content: [
                        { type: 'text', text: systemPrompt + "\n\nAnalyse cette étiquette :" }, 
                        { type: 'image_url', imageUrl: image }
                    ] }];
                } else {
                    messages = messages.concat(context || []);
                    messages.push({ role: 'user', content: question });
                }

                const chatResponse = await client.chat.complete({ 
                    model: image ? "pixtral-12b-2409" : "mistral-small-latest", 
                    temperature: 0.2, 
                    messages: messages 
                });
                const answer = chatResponse.choices[0].message.content;

                try {
                    const logLine = `[${new Date().toLocaleString()}] Démo: "${question}"\n`;
                    fs.appendFile('./journal_complet.txt', logLine, ()=>{});
                } catch (e) {}

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ answer: answer }));

            } catch (e) {
                console.error(e);
                res.writeHead(500); res.end(JSON.stringify({ answer: "[STOP] Désolé, une erreur technique est survenue. Veuillez réessayer." }));
            }
        });
    } else if (req.method === "POST" && req.url === "/feedback") {
        res.writeHead(200); res.end(JSON.stringify({ status: "ok" }));
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log(`Serveur DÉMO en ligne sur le port ${PORT}`); });