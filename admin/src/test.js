import { db, doc, setDoc } from './firebase.js';

async function test() {
  console.log("Starting setDoc test...");
  try {
    await setDoc(doc(db, 'admins', 'test@example.com'), {
      addedAt: new Date(),
      role: 'superadmin'
    }, { merge: true });
    console.log("setDoc success!");
  } catch (e) {
    console.error("setDoc failed:", e);
  }
}
test();
