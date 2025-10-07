// backend/firebaseAdmin.js
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const hasEnv =
    !!process.env.FIREBASE_PROJECT_ID &&
    !!process.env.FIREBASE_CLIENT_EMAIL &&
    !!process.env.FIREBASE_PRIVATE_KEY;

  if (hasEnv) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    console.log('[firebase-admin] initialized via ENV:', process.env.FIREBASE_PROJECT_ID);
  } else {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('[firebase-admin] initialized via serviceAccountKey.json:', serviceAccount.project_id);
  }
}

// firestore 핸들 바로 꺼내서 함께 export
const db = admin.firestore();
module.exports = { admin, db };