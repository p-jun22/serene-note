// src/firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";


const firebaseConfig = {
  apiKey: "AIzaSyCj5-5-prs1YDQRAzgukuR5FUsR6n1dLuc",
  authDomain: "serene-note.firebaseapp.com",
  projectId: "serene-note",
  storageBucket: "serene-note.firebasestorage.app",
  messagingSenderId: "202958092065",
  appId: "1:202958092065:web:0a41ceb976dd8374933060",
  measurementId: "G-BPSP2TDZHK"
};

const app = initializeApp(firebaseConfig);

const db = getFirestore(app);
const auth = getAuth(app);


export { app, db, auth };
