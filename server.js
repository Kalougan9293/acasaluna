// CORRECTION : Try/catch pour éviter le crash dotenv sur Render
try { require('dotenv').config(); } catch (e) { console.log("Mode Production"); }

const { Mistral } = require('@mistralai/mistralai');
const http = require("http");
const fs = require("fs");
const path = require("path");

// --- CHARGEMENT SÉCURISÉ DU MENU (ANTI-CRASH) ---
let menuData = { carte_des_vins: {}, carte_des_plats: {} };

try {
    menuData = require('./menu.json');
    console.log("✅ SUCCÈS : Le fichier menu.json a été lu correctement !");
} catch (error) {
    console.log("⚠️ ATTENTION : Problème avec le fichier menu.json");
    menuData = {
        carte_des_vins: { "Vins": [{ "nom": "Menu Introuvable", "prix": "0€" }] },
        carte_des_plats: { "Plats": ["Menu Introuvable"] }
    };
}
// ------------------------------------------------

const client = new Mistral({apiKey: process.env.MISTRAL_API_KEY});

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === "GET") {
        let filePath = req.url === "/" ? "app.html" : req.url.substring(1);
        const ext = path.extname(filePath);
        let contentType = "text/html";
        if (ext === ".png") contentType = "image/png";
        if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
        if (ext === ".js") contentType = "application/javascript";

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
                let { question, image, context } = JSON.parse(body);
                if (question && question.length > 500) question = question.substring(0, 500);
                console.log("🗣️ DEMANDE :", question);

                // --- CERVEAU A CASA LUNA (PROMPT V98 : STRATÉGIE REPAS COMPLET) ---
                const systemPrompt = `Tu es le Sommelier du restaurant "A Casa Luna" (Corse Gastronomique).
                
                🚨 RÈGLES D'OR :
                1. Tu ne dois JAMAIS inventer un vin. Tu dois UNIQUEMENT piocher dans la liste JSON.
                2. Si l'utilisateur a des préférences explicites ("Je veux du Rouge"), c'est la LOI.
                
                🧠 STRATÉGIE D'ACCORD (IMPORTANT) :
                - Si l'utilisateur choisit plusieurs plats (ex: Entrée + Plat), ton objectif est de proposer **UNE SEULE BOUTEILLE** qui fait le consensus.
                - **PRIORITÉ AU PLAT PRINCIPAL :** Choisis le vin qui va le mieux avec le Plat de Résistance (Viande/Poisson). C'est le cœur du repas.
                - Si l'entrée jure avec ce vin (ex: Poisson en entrée, Sanglier en plat), privilégie quand même le Sanglier (le vin Rouge), et explique que ce vin montera en puissance pour le plat.
                - Ne propose JAMAIS 3 vins différents pour un seul repas, sauf si on te le demande explicitement.

                📜 VOICI LA CARTE DES VINS :
                ${JSON.stringify(menuData.carte_des_vins)}

                📜 VOICI LA CARTE DES PLATS :
                ${JSON.stringify(menuData.carte_des_plats)}

                STRUCTURE DE RÉPONSE OBLIGATOIRE :

                [DEMANDE] : 
                (Fais une liste à puces propre des plats choisis.)

                [SUGGESTION] :
                (Nom EXACT du vin tel qu'écrit dans la liste JSON)
                (Ajoute le type entre parenthèses : Rouge, Blanc...)

                [EXPLICATION] :
                (Explique ton choix stratégique. Ex: "J'ai choisi ce vin rouge pour sublimer votre Civet de Sanglier. Il accompagnera aussi votre entrée charcutière avec brio..." Sois pédagogue, concis et rassurant sur l'accord.)

                [AROMES] :
                (3 arômes clés. Format: "Famille (Détail)")

                [PROFIL_VIN] :
                (Estime le profil gustatif. 3 critères avec note sur 5. Ex: "Corps (4/5)")

                [DEGRE] :
                (Indique le style ET le degré d'alcool estimé. Ex: "13.5° - Puissant & Ensoleillé")

                [AVIS_SOMMELIER] :
                (Donne un conseil de DÉGUSTATION (ex: "Aérez-le bien dans le verre") OU une anecdote corse courte. Ne parle PAS de température de service.)

                Langue: Français`;

                let messages = [];
                let model = "";
                let currentContext = context || [];

                if (image) {
                    model = "pixtral-12b-2409";
                    messages = [{ role: 'user', content: [
                        { type: 'text', text: systemPrompt + "\n\nANALYSE CETTE IMAGE." }, 
                        { type: 'image_url', imageUrl: image }
                    ] }];
                } else {
                    model = "mistral-small-latest";
                    messages = [{ role: 'system', content: systemPrompt }];
                    messages = messages.concat(currentContext);
                    messages.push({ role: 'user', content: question });
                }

                const chatResponse = await client.chat.complete({ 
                    model: model, 
                    temperature: 0.2, 
                    messages: messages,
                    maxTokens: 2000 
                });
                const answer = chatResponse.choices[0].message.content;
                
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ answer: answer }));

            } catch (e) {
                console.error("ERREUR :", e.message);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ answer: "[ERREUR] Problème technique." }));
            }
        });

    } else if (req.method === "POST" && req.url === "/feedback") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            res.writeHead(200); res.end(JSON.stringify({ status: "ok" }));
        });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log(`French Sommelier est en ligne sur le port ${PORT} !`); });