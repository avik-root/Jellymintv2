import admin from 'firebase-admin';
import fs from 'fs';

const serviceAccountPath = './serviceAccountKey.json';
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const testUid = '3TaX5m1IaIXLMYh4gtqDk661RGJ3'; // Avik Samanta
const API_KEY = 'AIzaSyCIseP-eoi7OSzM3ibdNzPvcyilupBnU6w';

async function runTest() {
  try {
    console.log("1. Setting freeForAll to false...");
    await db.collection('settings').doc('global').set({ freeForAll: false }, { merge: true });

    console.log("2. Checking initial token balance...");
    const userRef = db.collection('users').doc(testUid);
    const userSnap = await userRef.get();
    const initialTokens = userSnap.data().tokens;
    console.log(`Initial tokens: ${initialTokens}`);

    console.log("3. Acquiring ID token for auth...");
    const customToken = await admin.auth().createCustomToken(testUid);
    const exchangeUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`;
    const exchangeResponse = await fetch(exchangeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true })
    });
    const exchangeData = await exchangeResponse.json();
    const idToken = exchangeData.idToken;

    console.log("4. Sending chat request to RPi Backend...");
    const chatResponse = await fetch('https://spousal-scrabble-stamina.ngrok-free.dev/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        model: 'qwen2.5-coder:3b',
        messages: [{ role: 'user', content: 'Say "Test"' }]
      })
    });

    if (!chatResponse.ok) {
      const text = await chatResponse.text();
      throw new Error(`Chat request failed: ${chatResponse.status} - ${text}`);
    }

    console.log("5. Reading response stream...");
    const reader = chatResponse.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let outputText = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      outputText += chunk;
      console.log("CHUNK:", chunk);
    }
    console.log("Raw Stream Output length:", outputText.length);

    console.log("6. Waiting 3 seconds for backend Firestore update...");
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log("7. Checking final token balance...");
    const finalUserSnap = await userRef.get();
    const finalTokens = finalUserSnap.data().tokens;
    console.log(`Final tokens: ${finalTokens}`);
    console.log(`Difference: ${finalTokens - initialTokens} tokens`);

    // Clean up
    console.log("8. Restoring freeForAll to true...");
    await db.collection('settings').doc('global').set({ freeForAll: true }, { merge: true });

    process.exit(0);
  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  }
}

runTest();
