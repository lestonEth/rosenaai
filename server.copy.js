
// Improved initialization section
const express = require("express");
const { urlencoded } = require("body-parser");
const twilio = require("twilio");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

// Replace with your Google Gemini API key
const GEMINI_API_KEY = "AIzaSyDcZF8AbVK2TCEYEXawTXTsgsTAfxnPkv8";

// Company configuration - easily adjustable
const COMPANY_NAME = "Acme Insurance";
const COMPANY_TAGLINE = "where peace of mind is our policy";

// In-memory stores for conversation context
const callVoices = {};
const conversationHistory = {};
const callAttempts = {};

// Enhanced end terms detection with more natural phrases
const endTerms = [
  "goodbye", "bye", "thank you", "thanks", "that's all", 
  "no more questions", "end call", "hang up", "that's it", 
  "i'm done", "all set", "that's helpful"
];

// Function to query Google Gemini with conversation context
async function getGeminiResponse(question, callSid) {
    try {
        // Get conversation history or initialize if new
        if (!conversationHistory[callSid]) {
            conversationHistory[callSid] = [];
        }
        
        // Build conversation context with history
        const conversationContext = conversationHistory[callSid].join("\n");
        
        // Create prompt with conversation history for continuity
        const prompt = `You are ${COMPANY_NAME}'s AI assistant helping with insurance questions.
            
IMPORTANT GUIDELINES:
- Keep responses under 3 sentences when possible
- Be conversational but professional
- Focus on insurance topics only
- Don't mention that you're an AI unless asked
- If you don't know something, suggest speaking with a human agent
            
Previous conversation:
${conversationContext}
            
Customer's new question: ${question}`;
            
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
                contents: [
                    {
                        role: "user",
                        parts: [{ text: prompt }]
                    }
                ]
            },
            {
                headers: { "Content-Type": "application/json" }
            }
        );
        
        const responseText = response.data.candidates[0].content.parts[0].text.trim();
        
        // Update conversation history (keep last 5 exchanges for context)
        conversationHistory[callSid].push(`Q: ${question}`);
        conversationHistory[callSid].push(`A: ${responseText}`);
        
        if (conversationHistory[callSid].length > 10) {
            conversationHistory[callSid] = conversationHistory[callSid].slice(-10);
        }
        
        return responseText;
    } catch (error) {
        console.error("Error querying Google Gemini:", error);
        return `I'm sorry, we're experiencing a brief technical issue. Would you like to try asking again, or would you prefer to speak with a customer service representative?`;
    }
}

// Twilio webhook endpoint for handling incoming calls
app.post("/incoming-call", async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    
    // Initialize tracking for this call if needed
    if (!callVoices[callSid]) {
        // Consistently use the same voice for a more cohesive brand experience
        callVoices[callSid] = "Polly.Joanna-Neural";
        callAttempts[callSid] = 0;
    }
    
    const voice = callVoices[callSid];
    const speechResult = req.body.SpeechResult;
    
    // Voice parameters for more natural-sounding responses
    const voiceParams = {
        voice: voice,
        prosody: { rate: "0.9", pitch: "0" }  // Slightly slower rate for clarity
    };
    
    // Handle speech input from the customer
    if (speechResult) {
        // Reset attempt counter when user responds
        callAttempts[callSid] = 0;
        
        // Check if the user wants to end the call
        const isEndTerm = endTerms.some(term => 
            speechResult.toLowerCase().includes(term)
        );
        
        if (isEndTerm) {
            // Personalized farewell message
            twiml.say(voiceParams, 
                `Thank you for calling ${COMPANY_NAME}. We appreciate your business and are here when you need us. Have a wonderful day!`
            );
            twiml.hangup();
        } else {
            // Get contextual response from Gemini
            const geminiResponse = await getGeminiResponse(speechResult, callSid);
            
            // Deliver the response with a brief pause for natural conversation
            twiml.pause({ length: 0.5 });
            twiml.say({
                voice: voice, // Use the voice selected for this call
            }, geminiResponse);
            twiml.pause({ length: 0.8 });
            
            // Different follow-up prompts to avoid repetition
            const followupPrompts = [
                `What else would you like to know?`,
                `Is there anything else I can help you with today?`,
                `Do you have any other insurance questions?`,
                `What other questions can I answer for you?`
            ];
            
            const promptIndex = Math.floor(Math.random() * followupPrompts.length);
            twiml.say(voiceParams, followupPrompts[promptIndex]);
            
            // Add a brief pause before the beep for a more natural flow
            twiml.pause({ length: 1 });
            twiml.play("http://127.0.0.1:3000/beep.wav");
            
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
        // Initial greeting or handling silent/no input
        if (req.body.SpeechResult === undefined && req.body.Digits === undefined) {
            // Track empty response attempts
            callAttempts[callSid]++;
            
            if (callAttempts[callSid] === 1) {
                // First-time greeting with company branding
                twiml.pause({ length: 0.5 });
                twiml.say(voiceParams, 
                    `Thank you for calling ${COMPANY_NAME}, ${COMPANY_TAGLINE}. My name is Joanna, and I'm your virtual insurance assistant.`
                );
                twiml.pause({ length: 0.7 });
                twiml.say(voiceParams,
                    `I can help with policy questions, claims information, or coverage details. How may I assist you today?`
                );
                
                // Brief pause, then listen
                twiml.pause({ length: 1.5 });
                
            } else if (callAttempts[callSid] <= 2) {
                // Second attempt - gentle reminder
                twiml.say(voiceParams, 
                    `I'm still here. Please let me know how I can help with your insurance needs today.`
                );
            } else {
                // Third attempt - offer human support and prepare to end call
                twiml.say(voiceParams, 
                    `I notice we're having trouble connecting. If you'd like to speak with a customer service representative, please stay on the line and I'll transfer you shortly. Otherwise, feel free to call back at your convenience.`
                );
                twiml.pause({ length: 3 });
                twiml.say(voiceParams, `Thank you for calling ${COMPANY_NAME}. Goodbye.`);
                twiml.hangup();
                
                // Clean up memory for this call
                delete callVoices[callSid];
                delete conversationHistory[callSid];
                delete callAttempts[callSid];
                
                res.type("text/xml");
                res.send(twiml.toString());
                return;
            }
            
            // Add beep and listen
            twiml.play("http://127.0.0.1:3000/beep.wav");
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
    
    res.type("text/xml");
    res.send(twiml.toString());
});

// Cleanup function to prevent memory leaks (run periodically)
setInterval(() => {
    const currentTime = Date.now();
    // Clean up calls older than 30 minutes
    for (const callSid in callVoices) {
        if (callVoices[callSid].timestamp && currentTime - callVoices[callSid].timestamp > 30 * 60 * 1000) {
            delete callVoices[callSid];
            delete conversationHistory[callSid];
            delete callAttempts[callSid];
        }
    }
}, 15 * 60 * 1000); // Run every 15 minutes

// Start the server
const PORT = process.env.PORT || 3006;
app.listen(PORT, () => {
    console.log(`${COMPANY_NAME} voice assistant running on port ${PORT}`);
});