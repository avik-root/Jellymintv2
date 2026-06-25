import admin from 'firebase-admin';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import dotenv from 'dotenv';
dotenv.config();

initializeApp({
  credential: applicationDefault()
});
const db = getFirestore();

async function test() {
  try {
    console.log("Testing Firestore...");
    await db.collection('settings').doc('global').get();
    console.log("Success!");
  } catch (e) {
    console.error("Firestore error:", e);
  }
}
test();
