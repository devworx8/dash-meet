import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export async function generateMeetingMinutes(transcript: string) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `You are a professional meeting assistant. Based on the following meeting transcript, generate concise meeting minutes. 
      Include a summary, a list of action items, and key decisions made.
      Format the output as a JSON object with the following structure:
      {
        "summary": "...",
        "actionItems": ["...", "..."],
        "keyDecisions": ["...", "..."]
      }
      
      Transcript:
      ${transcript}`,
      config: {
        responseMimeType: "application/json",
      },
    });

    return JSON.parse(response.text || "{}");
  } catch (error) {
    console.error("Error generating minutes:", error);
    return null;
  }
}

export async function transcribeAudio(audioBlob: Blob) {
  // In a real app, we'd use a speech-to-text API.
  // For this demo, we'll simulate transcription or use Gemini's multimodal capabilities if possible.
  // Since we are in a browser, we'll use the Web Speech API for real-time transcription.
  return "";
}
