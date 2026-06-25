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

async function check() {
  const globalRef = db.collection('settings').doc('global');
  const globalSnap = await globalRef.get();
  console.log("=== GLOBAL SETTINGS ===");
  if (globalSnap.exists) {
    console.log(JSON.stringify(globalSnap.data(), null, 2));
  } else {
    console.log("No global settings document found.");
  }

  console.log("\n=== USERS ===");
  const usersSnap = await db.collection('users').get();
  usersSnap.forEach(doc => {
    console.log(`${doc.id} (${doc.data().name || 'No Name'} / ${doc.data().email || 'No Email'}): Tokens: ${doc.data().tokens}, Tier: ${doc.data().tier}`);
  });
  process.exit(0);
}

check();
