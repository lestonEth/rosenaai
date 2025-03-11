// Updated with all stability improvements
const express = require("express");
const { urlencoded } = require("body-parser");
const twilio = require("twilio");
const axios = require("axios");
const path = require("path");
const logger = require("morgan");
const rateLimit = require("express-rate-limit");
const validateTwilioRequest = twilio.validateRequest;


// Middleware
const app = express();
app.set('trust proxy', 'loopback');
app.use(logger("dev"));
app.use(urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

// Configuration
const GEMINI_API_KEY = "AIzaSyDcZF8AbVK2TCEYEXawTXTsgsTAfxnPkv8";
const COMPANY_NAME = "Acme Insurance";
const COMPANY_TAGLINE = "where peace of mind is our policy";
const MAX_HISTORY_LENGTH = 10;
const CALL_TIMEOUT_MINUTES = 30;

// Rate limiting
const callLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use("/incoming-call", callLimiter);

// In-memory stores with timestamp tracking
const callVoices = {};       // { callSid: { voice, timestamp } }
const conversationHistory = {}; // { callSid: [history] }
const callAttempts = {};     // { callSid: attemptCount }
const voiceOptions = ["Polly.Joanna-Neural", "Polly.Matthew-Neural"];

// End terms detection
const endTerms = new Set([
    "goodbye", "bye", "thank you", "thanks", "that's all", 
    "no more questions", "end call", "hang up", "that's it", 
    "i'm done", "all set", "that's helpful"
]);

// Twilio request validation middleware
app.use("/incoming-call", (req, res, next) => {
    if (process.env.NODE_ENV === "production") {
        const valid = validateTwilioRequest(
            process.env.TWILIO_AUTH_TOKEN,
            req.headers["x-twilio-signature"],
            `${process.env.TWILIO_WEBHOOK_URL}/incoming-call`,
            req.body
        );
        if (!valid) return res.status(403).send("Invalid Twilio request");
    }
    next();
});

// Gemini API integration
async function getGeminiResponse(question, callSid) {
    try {
        const history = conversationHistory[callSid] || [];
        const context = history.slice(-MAX_HISTORY_LENGTH).join("\n");
        
        const prompt = `As ${COMPANY_NAME}'s AI assistant, follow these rules:
1. Keep responses under 3 sentences
2. Be professional but friendly
3. Insurance focus only
4. Never mention you're an AI
5. Offer human agent transfer if unsure

Conversation history:
${context}

New question: ${question}`;

        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
            { contents: [{ role: "user", parts: [{ text: prompt }] }] },
            { headers: { "Content-Type": "application/json" }, timeout: 5000 }
        );

        const responseText = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 
                          "Could you please rephrase your question?";

        // Update conversation history
        conversationHistory[callSid] = [
            ...history.slice(-(MAX_HISTORY_LENGTH-2)),
            `Q: ${question}`,
            `A: ${responseText}`
        ];

        return responseText;
    } catch (error) {
        console.error("Gemini Error:", error.response?.data || error.message);
        return "Let me connect you to a human representative for better assistance. Please hold...";
    }
}

// Twilio voice handler
app.post("/incoming-call", async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    const speechResult = req.body.SpeechResult?.trim();

    // Initialize call tracking
    if (!callVoices[callSid]) {
        const randomVoice = Math.random() < 0.5 ? "Polly.Matthew-Neural" : "Polly.Joanna-Neural";  
        callVoices[callSid] = {
            voice: randomVoice,
            timestamp: Date.now()
        };
        callAttempts[callSid] = 0;
    } else {
        callVoices[callSid].timestamp = Date.now();
    }

    const { voice } = callVoices[callSid];
    const voiceConfig = { 
        voice, 
        prosody: { rate: "0.9", pitch: "0" } 
    };

    // Handle user input
    if (speechResult) {
        callAttempts[callSid] = 0;  // Reset attempts
        const userInput = speechResult.toLowerCase().trim().replace(/[.,!?]/g, "");

        if ([...endTerms].some(term => userInput.includes(term))) {
            twiml.say(voiceConfig, `Thank you for choosing ${COMPANY_NAME}. Have a secure day!`);
            twiml.hangup();
            return res.type("text/xml").send(twiml.toString());
        } else {
            const geminiResponse = await getGeminiResponse(speechResult, callSid);
            
            twiml.pause({ length: 0.5 });
            twiml.say(voiceConfig, geminiResponse);
            twiml.pause({ length: 0.8 });
            
            const prompts = [
                "What else can I help with?",
                "How else may I assist you?",
                "Do you have other insurance questions?",
                "What would you like to know next?"
            ];
            twiml.say(voiceConfig, prompts[Math.floor(Math.random() * prompts.length)]);
            
            twiml.pause({ length: 1 });
            twiml.play("https://distinct-useful-lark.ngrok-free.app/beep.wav");
            
            twiml.gather({
                input: "speech",
                action: "/incoming-call",
                speechTimeout: 4,
                timeout: 8,
                speechModel: "phone_call",
                actionOnEmptyResult: true
            });
        }
    } else {
        callAttempts[callSid]++;
        
        if (callAttempts[callSid] > 2) {
            twiml.say(voiceConfig,
                `It seems like you're unavailable at the moment. We hope you have a wonderful day! If you need assistance, feel free to call us back anytime.`
            );
            twiml.hangup();
        } else {
            // Updated greeting messages
            const greetings = [
                `Welcome to ${COMPANY_NAME}, where your security and peace of mind matter most. How can I assist you today?`,
                `Hello and thank you for calling ${COMPANY_NAME}. Are you inquiring about a policy, a claim, or something else?`,
                `You've reached ${COMPANY_NAME}, your trusted partner in insurance. How may I help?`,
                `At ${COMPANY_NAME}, we prioritize your protection. What can I do for you today?`,
                `Welcome to ${COMPANY_NAME}, where we help you safeguard what matters. How can I assist you?`
            ];
            
            twiml.say(voiceConfig, greetings[callAttempts[callSid] % greetings.length]);
            twiml.play("https://distinct-useful-lark.ngrok-free.app/beep.wav");
            twiml.gather({
                input: "speech",
                action: "/incoming-call",
                speechTimeout: 4,
                timeout: 8,
                speechModel: "phone_call",
                actionOnEmptyResult: true
            });
        }
    }

    res.type("text/xml").send(twiml.toString());
});

// Cleanup old calls
setInterval(() => {
    const now = Date.now();
    for (const callSid in callVoices) {
        if (now - callVoices[callSid].timestamp > CALL_TIMEOUT_MINUTES * 60 * 1000) {
            delete callVoices[callSid];
            delete conversationHistory[callSid];
            delete callAttempts[callSid];
        }
    }
}, 15 * 60 * 1000);

// Health check endpoint
app.get("/health", (req, res) => {
    res.json({
        status: "operational",
        activeCalls: Object.keys(callVoices).length,
        memoryUsage: process.memoryUsage()
    });
});

app.get("/", (req, res) => {
    res.send("Acme Insurance IVR is running!");
});

// Optional: Handle HEAD requests (often used for health checks)
app.head("/", (req, res) => {
    res.status(200).end();
});


// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`${COMPANY_NAME} IVR running on port ${PORT}`);
});